import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EMBEDDER_URL } from "../core/embedder";
import {
  IS_COMPILED_HELPER,
  LIFE_CODE_DIR,
  LIFE_STATE_DIR,
  OWNER_DATA_DIR,
} from "../core/paths";
import { APP_DATA, CODEX, HOME } from "../core/platform";
import { execOk } from "../core/proc";
import { isKeptAs, keepRunning, stopRunning } from "../core/service";
import { settings } from "../core/settings";
import {
  readOwnerOnly,
  readVoiceSecrets,
  secretOf,
  VOICE_SECRETS,
} from "../sources/lifelog-call";

// Voice: the pendant pipeline's processes on this Mac (its server, the Mac helper, speaker recognition, the embedder),
// each a launchd job Life's helper installs (`voiceStart`), so a Life crash, quit or update never stops them: the server
// holds the only copy of the pendant's audio. Each job runs `life voice run <child>`, which becomes the child (`execve`)
// with its environment worked out here: the one table of what each runs. Formerly Lifelog Host's children.

/** The server's port, on loopback only; Life's origin forwards `/voice` to it. */
const PORT = 47_613;
const LOOPBACK = `http://127.0.0.1:${PORT}`;
/** Speaker recognition's port, on loopback beside it. */
const IDENTITY_PORT = 47_614;
export const VOICE_CHILDREN = [
  "server",
  "quiet",
  "identity",
  "embedder",
] as const;
export type VoiceChild = (typeof VOICE_CHILDREN)[number];
/** The secrets voice mints when missing: the phone's token, the helper's, a reader's with corrections (Life's), the backup's password and speaker recognition's. */
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
  /** The commit Life.app was built from (`LIFE_BUILD`), naming the server's error reports. */
  build?: string;
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
}

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
const defined = (o: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries(o).filter((e): e is [string, string] => e[1] !== undefined)
  );

/** The archive's file and audio under `support`: all that `lifelog-server export` and `import` need. */
export const archiveEnvOf = (support: string) => ({
  AUDIO_DIR: join(support, "audio"),
  DATABASE_PATH: join(support, "archive.sqlite"),
});

/**
 * The server's environment: its archive, the token hashes (never the tokens), the owner's keys, the address the phone
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
    PORT: String(PORT),
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
  return { ...extra, ...archiveEnvOf(v.at.support), ...own };
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
  quiet: ({ at }) => ({
    args: [],
    binary: join(at.helpers, "lifelog-quiet"),
    env: { LIFELOG_CODEX: at.codex, LIFELOG_URL: LOOPBACK },
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

/**
 * `server.env`: `KEY='value'` lines (a single-quoted value may span lines, as a PEM key does), `KEY="value"` or
 * `KEY=value`; blank lines and `#` comments are skipped.
 */
export function parseServerEnv(text: string) {
  const line =
    /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"]*)"|([^\n]*))$/gm;
  const values: Record<string, string> = {};
  for (const [, key, single, double, bare] of text.matchAll(line)) {
    values[key as string] =
      single ??
      double ??
      bare?.replace(/^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu, "") ??
      "";
  }
  return values;
}

/** What every launch is worked out from, read now: the secrets as stored, `server.env` (owner-only), his settings. */
export function readVoiceInputs(
  at: VoicePaths,
  secrets = readVoiceSecrets()
): VoiceInputs {
  // The same refusal as the secrets': a server.env others can read stops the run.
  const extra = parseServerEnv(readOwnerOnly(at.serverEnv) ?? "");
  const origin = settings().connector?.origin;
  return {
    at,
    backups: settings().voice?.backups === true,
    build: process.env.LIFE_BUILD,
    extra,
    publicUrl: origin ? `${origin}/voice` : LOOPBACK,
    secrets,
    speakers: settings().voice?.speakers !== false,
  };
}

/**
 * The secrets with what they lack minted (32 random bytes, base64url), written back only when something was: any
 * already there is kept (a new backup password would lock out every snapshot made with the old one), and so is every
 * key voice doesn't own (the Mac helper's Claude sign-in). The one writer of the file: owner-only from its first byte,
 * in a folder made owner-only.
 */
export function mintVoiceSecrets(file = VOICE_SECRETS) {
  const stored = readVoiceSecrets(file);
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
  mkdirSync(dirname(file), { mode: 0o700, recursive: true });
  const temporary = `${file}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, JSON.stringify(secrets), {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, file);
  return secrets;
}

const jobOf = (child: VoiceChild) => `voice-${child}`;
/** What launchd runs for `child`: this helper with Life's paths (no secret), and the digest of its launch, so the plist changes when, and only when, what the child would run with does. */
const jobArgsOf = (child: VoiceChild, launch: VoiceLaunch) => [
  "/usr/bin/env",
  `LIFE_CODE_DIR=${LIFE_CODE_DIR}`,
  `LIFE_OWNER_DATA_DIR=${OWNER_DATA_DIR}`,
  `LIFE_STATE_DIR=${LIFE_STATE_DIR}`,
  ...(process.env.LIFE_BUILD ? [`LIFE_BUILD=${process.env.LIFE_BUILD}`] : []),
  process.execPath,
  "voice",
  "run",
  child,
  `--launch=${sha256Hex(JSON.stringify(launch)).slice(0, 16)}`,
];

/**
 * Each child's launchd job written as it should run now: (re)started only when its plist changed, stopped when it is
 * not wanted or can't run. Returns what each is: `running`, `restarted`, `off` or why it can't run.
 * ponytail: a plist unchanged counts as running (launchd loads LaunchAgents at login); ask `launchctl print` if one
 * is ever found unloaded.
 */
export async function voiceStart(
  at = voicePathsHere(),
  o = { keep: keepRunning, stop: stopRunning }
) {
  const inputs = readVoiceInputs(at, mintVoiceSecrets());
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
    const args = jobArgsOf(child, launch);
    if (isKeptAs(jobOf(child), at.support, args)) {
      states[child] = "running";
      continue;
    }
    await o.keep(jobOf(child), at.support, args);
    states[child] = "restarted";
  }
  return states;
}

/** Every child's job stopped and removed. */
export async function voiceStop(stop = stopRunning) {
  for (const child of VOICE_CHILDREN) {
    // biome-ignore lint/performance/noAwaitInLoops: one job at a time
    await stop(jobOf(child));
  }
}

/**
 * Becomes `child` (launchd's job runs this): its launch worked out now, speaker recognition installed first (both
 * steps no-ops once done, offline too), then this process replaced by it, never its parent. Returns only when it
 * can't run.
 */
export async function voiceRun(child: VoiceChild, at = voicePathsHere()) {
  const inputs = readVoiceInputs(at);
  const launch = VOICE_LAUNCHES[child](inputs);
  if (typeof launch !== "object") {
    console.error(`voice ${child}: ${launch ?? "off"}`);
    return 1;
  }
  const env = {
    ...Object.fromEntries(
      PASSED.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))
    ),
    ...launch.env,
  };
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
  process.execve?.(launch.binary, [launch.binary, ...launch.args], env);
  return 1;
}

/** `voice start | stop | run <child>`: what Life.app and launchd run. */
export async function voiceCommand(args: string[]) {
  const [verb, child] = args;
  if (!IS_COMPILED_HELPER) {
    console.error(
      "voice runs from Life.app's helper only: its programs are in the app"
    );
    return 2;
  }
  if (verb === "start") {
    console.log(JSON.stringify(await voiceStart(), null, 2));
    return 0;
  }
  if (verb === "stop") {
    await voiceStop();
    return 0;
  }
  if (verb === "run" && VOICE_CHILDREN.includes(child as VoiceChild)) {
    return await voiceRun(child as VoiceChild);
  }
  console.error(
    `usage: life voice start | stop | run <${VOICE_CHILDREN.join("|")}>`
  );
  return 2;
}
