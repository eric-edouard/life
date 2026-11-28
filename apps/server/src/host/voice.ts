import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { EMBEDDER_URL } from "../core/embedder";
import { digest, sha256Of } from "../core/hash";
import {
  IS_COMPILED_HELPER,
  LIFE_CODE_DIR,
  LIFE_STATE_DIR,
  OWNER_DATA_DIR,
} from "../core/paths";
import { APP_DATA, CODEX, HOME, isOwnLife } from "../core/platform";
import { exec, execOk } from "../core/proc";
import { SECRETS, writeSecret } from "../core/secret";
import {
  isKeptAs,
  isLoaded,
  keepRunning,
  logOf,
  plistOf,
  readJobState,
  stopRunning,
} from "../core/service";
import { settings } from "../core/settings";
import {
  readOwnerOnly,
  readVoiceSecrets,
  secretOf,
  VOICE_URL,
} from "../sources/voice-server-call";

// Voice: the pendant pipeline's processes on this Mac (its server, the Mac helper, speaker recognition, the embedder),
// each a launchd job Life's helper installs (`voiceStart`), so a Life crash, quit or update never stops them: the server
// holds the only copy of the pendant's audio. Each job runs `life voice run <child>`, which becomes the child (`execve`)
// with its environment worked out here: the one table of what each runs. Formerly Lifelog Host's children.

/** Speaker recognition's port, on loopback beside it. */
const IDENTITY_PORT = 47_614;
export const VOICE_CHILDREN = [
  "server",
  "quiet",
  "identity",
  "embedder",
] as const;
export type VoiceChild = (typeof VOICE_CHILDREN)[number];
/** The secrets voice mints when missing: the phone's token, the helper's, a reader's with corrections (Lifelog Host's "Copy Life's lifelog settings" until it goes), the backup's password and speaker recognition's. */
const MINTED = [
  "deviceToken",
  "macToken",
  "readerToken",
  "resticPassword",
  "identitySecret",
];
/** What a child is given of the environment it is started in; the rest is its own (`CLI.environment`). */
const PASSED = ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "LC_ALL"];

/** Where voice's files are: its programs in Life.app (beside the helper), its data and logs on the Mac. */
export interface VoicePaths {
  backups: string;
  codex: string;
  helpers: string;
  resources: string;
  serverEnv: string;
  support: string;
}

/** The paths of the Life.app this helper runs from (`Contents/Helpers/life`). */
export function voicePathsHere(): VoicePaths {
  const helpers = dirname(process.execPath);
  const support = join(APP_DATA, "lifelog");
  return {
    backups: join(
      HOME,
      "Library/Mobile Documents/com~apple~CloudDocs/lifelog backup/restic"
    ),
    codex: join(LIFE_CODE_DIR, CODEX),
    helpers,
    resources: resolve(helpers, "..", "Resources"),
    serverEnv: join(support, "server.env"),
    support,
  };
}

/** What a child's launch is worked out from. */
export interface VoiceInputs {
  at: VoicePaths;
  backups: boolean;
  /** Which Life.app build this is (`buildOf`), naming the server's error reports. */
  build: string;
  /** The owner's own server keys voice doesn't manage (APNs, Resend…): `server.env`. */
  extra: Record<string, string>;
  /** The address the phone reaches the server at: Life's origin and `/voice`, else this Mac alone. */
  publicUrl: string;
  secrets: Record<string, unknown>;
  speakers: boolean;
}

/** A child's program, arguments and environment (its own; `PASSED` is added at the run). */
export interface VoiceLaunch {
  args: string[];
  binary: string;
  env: Record<string, string>;
  /** What else it reads only at its start (the Mac helper's Claude token), as a digest: in its plist's `--launch`, never in its run. */
  readsAtStart?: string;
}

const sha256Hex = (s: string) => digest("sha256", s, 64);
const defined = (o: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined)
  );

/** The recordings (their database and audio) under `support`: all that `lifelog-server export` and `import` need. */
export const recordingsEnvOf = (support: string) => ({
  AUDIO_DIR: join(support, "audio"),
  DATABASE_PATH: join(support, "archive.sqlite"),
});

/**
 * The server's environment: its recordings, the token hashes (never the tokens), the owner's keys, the address the phone
 * reaches, restic when backups are on, speaker recognition when it is on, the build, and `server.env` under them:
 * restic's and speaker recognition's keys are voice's, set or unset, so turning either off can't be undone by it.
 */
export function serverEnvOf(v: VoiceInputs): Record<string, string> {
  const s = (key: string) => secretOf(v.secrets, key);
  const hash = (key: string) => {
    const t = s(key);
    return t === undefined ? undefined : sha256Hex(t);
  };
  const own = defined({
    BUILD_SHA: v.build,
    CORRECTIONS_TOKEN_HASH: hash("readerToken"),
    DEVICE_TOKEN_HASH: hash("deviceToken"),
    ELEVENLABS_API_KEY: s("elevenLabsKey"),
    IDENTITY_SECRET: v.speakers ? s("identitySecret") : undefined,
    IDENTITY_URL: v.speakers ? `http://127.0.0.1:${IDENTITY_PORT}` : undefined,
    LISTEN_HOST: "127.0.0.1",
    MAC_TOKEN_HASH: hash("macToken"),
    PORT: new URL(VOICE_URL).port,
    PUBLIC_BASE_URL: v.publicUrl,
    RESTIC_BINARY: v.backups ? join(v.at.helpers, "restic") : undefined,
    RESTIC_PASSWORD: v.backups ? s("resticPassword") : undefined,
    RESTIC_REPOSITORY: v.backups ? v.at.backups : undefined,
  });
  const extra = Object.fromEntries(
    Object.entries(v.extra).filter(
      ([k]) => !(k.startsWith("RESTIC_") || k.startsWith("IDENTITY_"))
    )
  );
  return { ...extra, ...recordingsEnvOf(v.at.support), ...own };
}

/**
 * Speaker recognition's environment, for its install (`uv sync`, `app.py download`) and its run: the venv, uv's own
 * Python and the model all under `home`, never a Python of the system's that an upgrade could remove; the service on
 * loopback with the secret the server sends.
 */
export const identityEnvOf = (
  home: string,
  secrets: Record<string, unknown>
): Record<string, string> =>
  defined({
    HOST: "127.0.0.1",
    IDENTITY_SECRET: secretOf(secrets, "identitySecret"),
    MODEL_DIR: join(home, "model"),
    PORT: String(IDENTITY_PORT),
    UV_PROJECT_ENVIRONMENT: join(home, "venv"),
    UV_PYTHON_INSTALL_DIR: join(home, "python"),
    UV_PYTHON_PREFERENCE: "only-managed",
  });

/**
 * The embedder's arguments: `model` (a GGUF) served for embeddings only, on loopback at `EMBEDDER_URL`. Four slots of
 * 2048 tokens, the model's longest input (`core/embedder.ts`'s `EMBEDDED_BYTES`), on the GPU.
 */
export const embedderArgsOf = (model: string) => [
  "--embedding",
  "--model",
  model,
  "--host",
  "127.0.0.1",
  "--port",
  new URL(EMBEDDER_URL).port,
  "--ctx-size",
  "8192",
  "--batch-size",
  "2048",
  "--ubatch-size",
  "2048",
  "--parallel",
  "4",
  "--n-gpu-layers",
  "999",
];

const identityHomeOf = (at: VoicePaths) => join(at.support, "identity");
const identityProjectOf = (at: VoicePaths) => join(at.resources, "identity");

/**
 * The one table: how each child runs now, a reason it can't (a string), or nothing when it isn't wanted (speaker
 * recognition turned off).
 */
export const VOICE_LAUNCHES: Record<
  VoiceChild,
  (v: VoiceInputs) => VoiceLaunch | string | undefined
> = {
  embedder: ({ at }) => ({
    args: embedderArgsOf(join(at.resources, "embedder", "model.gguf")),
    binary: join(at.helpers, "llama", "llama-server"),
    env: {},
  }),
  identity: ({ at, secrets, speakers }) =>
    speakers
      ? {
          args: [join(identityProjectOf(at), "app.py")],
          binary: join(identityHomeOf(at), "venv", "bin", "python3"),
          env: identityEnvOf(identityHomeOf(at), secrets),
        }
      : undefined,
  quiet: ({ at, secrets }) => ({
    args: [],
    binary: join(at.helpers, "lifelog-quiet"),
    env: { LIFELOG_CODEX: at.codex, LIFELOG_URL: VOICE_URL },
    readsAtStart: digest("sha256", secretOf(secrets, "claudeToken") ?? "", 16),
  }),
  server: (v) =>
    secretOf(v.secrets, "elevenLabsKey")
      ? {
          args: [],
          binary: join(v.at.helpers, "lifelog-server"),
          env: serverEnvOf(v),
        }
      : "Add your ElevenLabs key in Settings to start transcribing.",
};

/** What every launch is worked out from, read now: the secrets as stored, `server.env` (owner-only), his settings. */
export async function readVoiceInputs(
  at: VoicePaths,
  secrets = readVoiceSecrets(),
  /** The build, worked out from the helper's binary: the status poll skips it. */
  build = buildOf
): Promise<VoiceInputs> {
  // The same refusal as the secrets': a server.env others can read stops the run.
  const extra = parseEnv(readOwnerOnly(at.serverEnv) ?? "") as Record<
    string,
    string
  >;
  const origin = settings().connector?.origin;
  return {
    at,
    backups: settings().voice?.backups === true,
    build: await build(),
    extra,
    publicUrl: origin ? `${origin}/voice` : VOICE_URL,
    secrets,
    speakers: settings().voice?.speakers !== false,
  };
}

/**
 * The secrets with what they lack minted (32 random bytes, base64url), written back only when something was: any
 * already there is kept (a new backup password would lock out every snapshot made with the old one), and so is every
 * key voice doesn't own (the Mac helper's Claude sign-in). With `setVoiceKey`, Life's only writes of the file (`SECRETS.voiceSecrets`).
 */
export function mintVoiceSecrets() {
  const stored = readVoiceSecrets();
  const missing = MINTED.filter((k) => secretOf(stored, k) === undefined);
  if (missing.length === 0) {
    return stored;
  }
  const secrets = {
    ...stored,
    ...Object.fromEntries(
      missing.map((k) => [k, randomBytes(32).toString("base64url")])
    ),
  };
  writeSecret("voiceSecrets", JSON.stringify(secrets));
  return secrets;
}

/** The keys the owner gives voice in Life.app's Settings: ElevenLabs' (transcription) and the Claude token (summaries). */
const OWNER_KEYS = ["elevenLabsKey", "claudeToken"];

/** One owner key set (blank removes it), every other secret kept as stored. */
export function setVoiceKey(name: string, value: string) {
  const { [name]: _, ...rest } = readVoiceSecrets();
  const secrets = value.trim() ? { ...rest, [name]: value.trim() } : rest;
  writeSecret("voiceSecrets", JSON.stringify(secrets));
}

/**
 * Which Life.app build this is: the start of the helper's own digest, the one thing every new build changes (its
 * Info.plist's version does not), so a new build rewrites every job and voice runs the new app's programs.
 */
export const buildOf = async () =>
  (await sha256Of(process.execPath)).slice(0, 12);

/**
 * The link the phone opens (`lifelog://pair?life=<origin>&code=<code>`), with voice's address and the phone's device
 * token (`url`, `token`) when given: one QR pairs both. `mac` and `relay` are the Mac's iroh address (`macAddressOf`),
 * which the phone reaches Life through whatever its origin is.
 */
export const pairLinkOf = (
  origin: string,
  code: string,
  token?: string,
  mac?: { mac: string; relay: string }
) =>
  `lifelog://pair?${new URLSearchParams({
    code,
    life: origin,
    ...(mac && { mac: mac.mac, relay: mac.relay }),
    ...(token && { token, url: `${origin}/voice` }),
  })}`;

/** The phone's device token for Life's pairing link: only from his own Life's helper, never a checkout or a second Life. */
export const pairTokenOf = (compiled = IS_COMPILED_HELPER) =>
  compiled && isOwnLife()
    ? secretOf(readVoiceSecrets(), "deviceToken")
    : undefined;

const jobOf = (child: VoiceChild) => `voice-${child}`;
/**
 * What launchd runs for `child`: this helper with Life's paths (no secret), its build and the digest of its launch, so
 * the plist changes when, and only when, a new build or what the child would run with does.
 */
export const jobArgsOf = (
  child: VoiceChild,
  launch: VoiceLaunch,
  build: string
) => [
  "/usr/bin/env",
  `LIFE_CODE_DIR=${LIFE_CODE_DIR}`,
  `LIFE_OWNER_DATA_DIR=${OWNER_DATA_DIR}`,
  `LIFE_STATE_DIR=${LIFE_STATE_DIR}`,
  process.execPath,
  "voice",
  "run",
  child,
  `--build=${build}`,
  `--launch=${digest("sha256", JSON.stringify(launch), 16)}`,
];

/** Why voice doesn't start: Lifelog Host runs it (same ports, recordings and outbox; two Mac helpers stall processing). */
export const HOST_RUNS = "Lifelog Host runs voice";
/**
 * Whether Lifelog Host runs: its app's own process, by its name alone (a command line naming its path, a shell or a
 * script, is not Host: on 28 Nov one made Life's voice jobs remove themselves). ponytail: goes with Host in bundle 4,
 * with `HOST_RUNS` and every use.
 */
export const isHostRunning = async () =>
  (await exec(["pgrep", "-x", "LifelogHost"])).code === 0;

/**
 * Each child's launchd job written as it should run now: (re)started only when its plist changed, stopped when it is
 * not wanted or can't run. Returns what each is: `running`, `restarted`, `off` or why it can't run.
 */
export async function voiceStart(
  at = voicePathsHere(),
  o = {
    hostRuns: isHostRunning,
    keep: keepRunning,
    loaded: isLoaded,
    stop: stopRunning,
  }
): Promise<Partial<Record<VoiceChild, string>>> {
  // Life's jobs go while Host runs: written at a login before Host's processes showed, launchd would run them at every login.
  if (await o.hostRuns()) {
    await voiceStop(o.stop);
    return Object.fromEntries(VOICE_CHILDREN.map((c) => [c, HOST_RUNS]));
  }
  const inputs = await readVoiceInputs(at, mintVoiceSecrets());
  mkdirSync(join(at.support, "audio"), { recursive: true });
  const states: Partial<Record<VoiceChild, string>> = {};
  for (const child of VOICE_CHILDREN) {
    const launch = VOICE_LAUNCHES[child](inputs);
    if (typeof launch !== "object") {
      // biome-ignore lint/performance/noAwaitInLoops: one job at a time
      await o.stop(jobOf(child));
      states[child] = launch ?? "off";
      continue;
    }
    const args = jobArgsOf(child, launch, inputs.build);
    if (await isKeptAs(jobOf(child), at.support, args, o.loaded)) {
      states[child] = "running";
      continue;
    }
    await o.keep(jobOf(child), at.support, args);
    states[child] = "restarted";
  }
  return states;
}

/** Whether any of voice's launchd jobs is written. */
export const hasVoiceJobs = () =>
  VOICE_CHILDREN.some((c) => existsSync(plistOf(jobOf(c), "", []).path));

/** Every child's job stopped and removed. */
export async function voiceStop(stop = stopRunning) {
  for (const child of VOICE_CHILDREN) {
    // biome-ignore lint/performance/noAwaitInLoops: one job at a time
    await stop(jobOf(child));
  }
}

/** What a child is given of this process's environment (`PASSED`), with `own` over it. */
const passedWith = (own: Record<string, string>) => ({
  ...Object.fromEntries(
    PASSED.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))
  ),
  ...own,
});

/**
 * Becomes `child` (launchd's job runs this): its launch worked out now, speaker recognition installed first (both
 * steps no-ops once done, offline too), then this process replaced by it, never its parent. Returns only when it
 * can't run.
 */
export async function voiceRun(
  child: VoiceChild,
  at = voicePathsHere(),
  o = { hostRuns: isHostRunning, stop: stopRunning }
) {
  if (await o.hostRuns()) {
    // Once: Life's jobs removed (its own last, which ends this process), so launchd never starts them beside Host.
    console.error(`voice ${child}: ${HOST_RUNS}; Life's voice jobs removed`);
    for (const job of [...VOICE_CHILDREN.filter((c) => c !== child), child]) {
      // biome-ignore lint/performance/noAwaitInLoops: one job at a time, this one last
      await o.stop(jobOf(job));
    }
    return 1;
  }
  const inputs = await readVoiceInputs(at);
  const launch = VOICE_LAUNCHES[child](inputs);
  if (typeof launch !== "object") {
    console.error(`voice ${child}: ${launch ?? "off"}`);
    return 1;
  }
  const env = passedWith(launch.env);
  if (child === "identity") {
    const project = identityProjectOf(at);
    await execOk(
      [join(at.helpers, "uv"), "sync", "--frozen", "--project", project],
      { env, timeout: 3_600_000 }
    );
    await execOk([launch.binary, join(project, "app.py"), "download"], {
      env,
      timeout: 3_600_000,
    });
  }
  // Typed optional by Node's types; Bun has it (voice.test.ts checks): a missing one throws, a run.error.
  (process.execve as NonNullable<typeof process.execve>)(
    launch.binary,
    [launch.binary, ...launch.args],
    env
  );
  return 1;
}

/** The Mac helper's own ChatGPT login (`codex login`), apart from the owner's everyday Codex. */
const CODEX_HOME = join(dirname(SECRETS.voiceSecrets), "codex");

/** Each child's launchd state (none when not loaded) and why it isn't meant to run (none when it is). */
export interface VoiceChildStatus {
  state: string | null;
  why: string | null;
}

/**
 * The status row's one line: what keeps voice from running (Lifelog Host, a missing key), else running with the
 * wanted children that aren't, else not answering.
 */
export function voiceLineOf(
  children: Record<VoiceChild, VoiceChildStatus>,
  answering: boolean
) {
  const all = Object.entries(children);
  const why = all.find(([, c]) => c.why && c.why !== "off")?.[1].why;
  if (why) {
    return why;
  }
  const down = all
    .filter(([, c]) => !c.why && c.state !== "running")
    .map(([name]) => name);
  if (!answering) {
    return "Not answering";
  }
  return down.length ? `Running; not running: ${down.join(", ")}` : "Running";
}

/**
 * What Life.app's Settings shows of voice, all decided here: its line (each child's why from `VOICE_LAUNCHES`, its
 * launchd state), whether the server answers `/health` on loopback, the switches as they apply, what is set up, and
 * each job's log. Never a secret, never the build (a binary's hash on a 5-second poll). What stops it being read (a
 * secrets file or server.env others can read) is its line alone.
 */
export async function voiceStatus(
  at = voicePathsHere(),
  hostRuns = isHostRunning
) {
  let inputs: VoiceInputs;
  try {
    inputs = await readVoiceInputs(at, readVoiceSecrets(), () =>
      Promise.resolve("")
    );
  } catch (e) {
    return { line: (e as Error).message };
  }
  const host = await hostRuns();
  const children = Object.fromEntries(
    await Promise.all(
      VOICE_CHILDREN.map(async (c) => {
        const launch = VOICE_LAUNCHES[c](inputs);
        const reason = typeof launch === "object" ? null : (launch ?? "off");
        const why = host ? HOST_RUNS : reason;
        return [c, { state: (await readJobState(jobOf(c))) ?? null, why }];
      })
    )
  ) as Record<VoiceChild, VoiceChildStatus>;
  const answering = await fetch(`${VOICE_URL}/health`, {
    signal: AbortSignal.timeout(2000),
  }).then(
    (r) => r.ok,
    () => false
  );
  return {
    answering,
    backups: inputs.backups,
    chatgpt: existsSync(join(CODEX_HOME, "auth.json")),
    claudeToken: secretOf(inputs.secrets, "claudeToken") !== undefined,
    elevenLabsKey: secretOf(inputs.secrets, "elevenLabsKey") !== undefined,
    iCloud: existsSync(dirname(dirname(at.backups))),
    line: voiceLineOf(children, answering),
    logs: Object.fromEntries(VOICE_CHILDREN.map((c) => [c, logOf(jobOf(c))])),
    recorded: existsSync(recordingsEnvOf(at.support).DATABASE_PATH),
    speakers: inputs.speakers,
  };
}

/**
 * `lifelog-server export|import <folder>` with only the recordings' paths, as one plain line. An import stops the server
 * first (the server refuses an install that holds recordings) and starts voice again after.
 */
export async function exportRecordings(
  verb: "export" | "import",
  folder: string,
  at = voicePathsHere()
) {
  mkdirSync(join(at.support, "audio"), { recursive: true });
  if (verb === "import") {
    await stopRunning(jobOf("server"));
  }
  const r = await exec([join(at.helpers, "lifelog-server"), verb, folder], {
    env: passedWith(recordingsEnvOf(at.support)),
    timeout: 3_600_000,
  });
  if (verb === "import") {
    await voiceStart(at);
  }
  return recordingsLineOf(verb, r.code, r.stdout);
}

/** How `lifelog-server export|import` ended, from its last line (`{ ok, files }` or `{ ok: false, error }`): never raw JSON. */
export function recordingsLineOf(verb: string, code: number, stdout: string) {
  const last = stdout.trim().split("\n").at(-1) ?? "";
  const stopped = `it stopped with status ${code}`;
  let result: { error?: string; files?: number; ok?: boolean };
  try {
    result = JSON.parse(last);
  } catch {
    result = { error: last || stopped };
  }
  const done = verb === "export" ? "Exported" : "Imported";
  return result.ok && code === 0
    ? { line: `${done} ${result.files ?? 0} files.`, ok: true }
    : { line: `The ${verb} failed: ${result.error ?? stopped}`, ok: false };
}

const USAGE = `usage: life voice start [--refresh] | stop | status | key <${OWNER_KEYS.join("|")}> (value on stdin) | backup-password | sign-in-chatgpt | export <folder> | import <folder> | run <${VOICE_CHILDREN.join("|")}>`;

/** `voice …`: what Life.app's Settings and launchd run. */
export async function voiceCommand(args: string[]) {
  const [verb, arg] = args;
  if (!IS_COMPILED_HELPER) {
    console.error(
      "voice runs from Life.app's helper only: its programs are in the app"
    );
    return 2;
  }
  if (verb === "start") {
    // `--refresh` (Life.app's launch and Save): only jobs already written; the first start is Settings' or the cut-over's.
    if (args.includes("--refresh") && !hasVoiceJobs()) {
      console.log("voice: no jobs to refresh");
      return 0;
    }
    console.log(JSON.stringify(await voiceStart(), null, 2));
    return 0;
  }
  if (verb === "stop") {
    await voiceStop();
    return 0;
  }
  if (verb === "status") {
    console.log(JSON.stringify(await voiceStatus()));
    return 0;
  }
  if (verb === "key" && arg && OWNER_KEYS.includes(arg)) {
    setVoiceKey(arg, await Bun.stdin.text());
    await voiceStart();
    return 0;
  }
  if (verb === "backup-password") {
    console.log(secretOf(mintVoiceSecrets(), "resticPassword"));
    return 0;
  }
  if (verb === "sign-in-chatgpt") {
    // Becomes `codex login` in the browser, so Life.app's Cancel stops it; the helper reads the login on every call.
    const { codex } = voicePathsHere();
    mkdirSync(CODEX_HOME, { mode: 0o700, recursive: true });
    (process.execve as NonNullable<typeof process.execve>)(
      codex,
      [codex, "login"],
      passedWith({ CODEX_HOME })
    );
    return 1;
  }
  if ((verb === "export" || verb === "import") && arg) {
    const r = await exportRecordings(verb, arg);
    console.log(r.line);
    return r.ok ? 0 : 1;
  }
  if (verb === "run" && VOICE_CHILDREN.includes(arg as VoiceChild)) {
    return await voiceRun(arg as VoiceChild);
  }
  console.error(USAGE);
  return 2;
}
