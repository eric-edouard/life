import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { EMBEDDER_URL } from "../core/embedder";
// biome-ignore lint/performance/noNamespaceImport: spied on, to read as his own Life.
import * as platform from "../core/platform";
import { SECRETS } from "../core/secret";
import { plistOf } from "../core/service";
import { setSettings, settings } from "../core/settings";
import { call, readVoiceSecrets } from "../sources/lifelog-call";
import {
  archiveEnvOf,
  archiveLineOf,
  embedderArgsOf,
  HOST_RUNS,
  identityEnvOf,
  jobArgsOf,
  mintVoiceSecrets,
  pairLinkOf,
  pairTokenOf,
  serverEnvOf,
  setVoiceKey,
  type VoiceInputs,
  type VoicePaths,
  voiceLineOf,
  voiceStart,
} from "./voice";

/** 32 random bytes, base64url without padding. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const at: VoicePaths = {
  backups: "/icloud/restic",
  codex: "/app/codex",
  helpers: "/app/Helpers",
  resources: "/app/Resources",
  serverEnv: "/s/server.env",
  support: "/s",
};
const inputs = (o: Partial<VoiceInputs> = {}): VoiceInputs => ({
  at,
  backups: false,
  build: "b1",
  extra: {},
  publicUrl: "http://127.0.0.1:47613",
  secrets: {},
  speakers: false,
  ...o,
});
const VOICE_SECRETS = SECRETS.voiceSecrets;
const minted = {
  identitySecret: "made-up-identity-secret",
  resticPassword: "made-up-restic-password",
};

test("the server gets hashes, never tokens, and listens on loopback", () => {
  const env = serverEnvOf(
    inputs({
      at: { ...at, support: "/tmp/voice" },
      publicUrl: "https://life.example/voice",
      secrets: {
        deviceToken: "phone-token",
        elevenLabsKey: "el",
        macToken: "mac-token",
        readerToken: "reader-token",
      },
    })
  );
  expect(env.DATABASE_PATH).toBe("/tmp/voice/archive.sqlite");
  expect(env.AUDIO_DIR).toBe("/tmp/voice/audio");
  expect(env.LISTEN_HOST).toBe("127.0.0.1");
  expect(env.PUBLIC_BASE_URL).toBe("https://life.example/voice");
  expect(env.DEVICE_TOKEN_HASH).toBe(sha("phone-token"));
  expect(env.CORRECTIONS_TOKEN_HASH).toBe(sha("reader-token"));
  expect(env.MAC_TOKEN_HASH).toBe(sha("mac-token"));
  expect(env.ELEVENLABS_API_KEY).toBe("el");
  expect(Object.values(env).some((v) => v.includes("token"))).toBe(false);
});

test("the embedder listens where Life embeds, with inputs no longer than core/embedder.ts sends", () => {
  const args = embedderArgsOf("/m.gguf");
  expect(args).toContain("/m.gguf");
  expect(args).toContain("127.0.0.1");
  expect(args).toContain(new URL(EMBEDDER_URL).port);
  // EMBEDDED_BYTES is this, less room for BOS and EOS.
  expect(args.join(" ")).toContain("--ubatch-size 2048");
});

test("minting fills only the missing secrets, keeps every key voice doesn't own, and writes an owner-only file once", () => {
  try {
    mkdirSync(dirname(VOICE_SECRETS), { recursive: true });
    writeFileSync(
      VOICE_SECRETS,
      JSON.stringify({ claudeToken: "claude", future: 1, macToken: "kept" }),
      { mode: 0o600 }
    );
    const secrets = mintVoiceSecrets();
    expect(secrets.macToken).toBe("kept");
    expect(secrets.claudeToken).toBe("claude");
    expect(secrets.future).toBe(1);
    for (const k of [
      "deviceToken",
      "readerToken",
      "resticPassword",
      "identitySecret",
    ]) {
      expect(String(secrets[k])).toMatch(TOKEN);
    }
    expect(secrets.deviceToken).not.toBe(secrets.readerToken);
    expect(readVoiceSecrets()).toEqual(secrets);
    expect(statSync(VOICE_SECRETS).mode.toString(8)).toEndWith("600");
    expect(mintVoiceSecrets()).toEqual(secrets);
    chmodSync(VOICE_SECRETS, 0o644);
    expect(() => mintVoiceSecrets()).toThrow("readable by others");
  } finally {
    rmSync(VOICE_SECRETS, { force: true });
  }
});

test("the owner's server.env goes under voice's own", () => {
  const extra = parseEnv(`# the owner's extras
RESEND_API_KEY='re_123'
export IDENTITY_SECRET="a secret with spaces"
PORT=1
APNS_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----
abc=
-----END PRIVATE KEY-----'
EMPTY=
`);
  expect(extra.RESEND_API_KEY).toBe("re_123");
  expect(extra.IDENTITY_SECRET).toBe("a secret with spaces");
  expect(extra.APNS_PRIVATE_KEY).toBe(
    "-----BEGIN PRIVATE KEY-----\nabc=\n-----END PRIVATE KEY-----"
  );
  expect(extra.EMPTY).toBe("");
  // A line inside a quoted value is not a key.
  expect(extra.abc).toBeUndefined();
  const env = serverEnvOf(
    inputs({
      build: "abc1234",
      extra: { ...extra, BUILD_SHA: "stale" },
      secrets: { elevenLabsKey: "el" },
    })
  );
  expect(env.RESEND_API_KEY).toBe("re_123");
  expect(env.PORT).toBe("47613");
  expect(env.BUILD_SHA).toBe("abc1234");
});

test("restic only when backups are on", () => {
  const off = serverEnvOf(inputs({ secrets: minted }));
  expect(off.RESTIC_PASSWORD).toBeUndefined();
  expect(off.RESTIC_REPOSITORY).toBeUndefined();
  const on = serverEnvOf(inputs({ backups: true, secrets: minted }));
  expect(on.RESTIC_PASSWORD).toBe(minted.resticPassword as string);
  expect(on.RESTIC_BINARY).toBe("/app/Helpers/restic");
  expect(on.RESTIC_REPOSITORY).toBe("/icloud/restic");
});

test("export and import get only the archive", () => {
  expect(archiveEnvOf("/s")).toEqual({
    AUDIO_DIR: "/s/audio",
    DATABASE_PATH: "/s/archive.sqlite",
  });
});

test("speaker recognition shares one secret with the server on loopback, and server.env can't turn it or restic on", () => {
  const off = serverEnvOf(inputs({ secrets: minted }));
  expect(off.IDENTITY_URL).toBeUndefined();
  expect(off.IDENTITY_SECRET).toBeUndefined();
  const leftover = serverEnvOf(
    inputs({
      extra: {
        IDENTITY_SECRET: "old",
        IDENTITY_URL: "http://old:8000",
        RESTIC_PASSWORD: "old",
      },
      secrets: minted,
    })
  );
  expect(leftover.IDENTITY_URL).toBeUndefined();
  expect(leftover.IDENTITY_SECRET).toBeUndefined();
  expect(leftover.RESTIC_PASSWORD).toBeUndefined();
  const on = serverEnvOf(inputs({ secrets: minted, speakers: true }));
  const service = identityEnvOf("/s/identity", minted);
  expect(on.IDENTITY_URL).toBe("http://127.0.0.1:47614");
  expect(on.IDENTITY_URL).toBe(`http://${service.HOST}:${service.PORT}`);
  expect(on.IDENTITY_SECRET).toBe(minted.identitySecret as string);
  expect(service.IDENTITY_SECRET).toBe(minted.identitySecret as string);
  expect(service.UV_PROJECT_ENVIRONMENT).toBe("/s/identity/venv");
  expect(service.MODEL_DIR).toBe("/s/identity/model");
  expect(service.UV_PYTHON_PREFERENCE).toBe("only-managed");
});

test("start restarts a job only when its plist changed, stops one that can't run, and puts no secret in a plist", async () => {
  const support = mkdtempSync(join(tmpdir(), "voice-support-"));
  const paths = { ...at, serverEnv: join(support, "server.env"), support };
  const kept: string[] = [];
  const stopped: string[] = [];
  const o = {
    hostRuns: () => Promise.resolve(false),
    keep: (job: string, dir: string, args: string[]) => {
      const { path, text } = plistOf(job, dir, args);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      kept.push(job);
      return Promise.resolve();
    },
    loaded: () => Promise.resolve(true),
    stop: (job: string) => {
      stopped.push(job);
      return Promise.resolve();
    },
  };
  try {
    rmSync(VOICE_SECRETS, { force: true });
    // No ElevenLabs key: the server can't run.
    expect((await voiceStart(paths, o)).server).toContain("ElevenLabs");
    expect(stopped).toContain("voice-server");
    expect(kept).toEqual(["voice-quiet", "voice-identity", "voice-embedder"]);
    writeFileSync(
      VOICE_SECRETS,
      JSON.stringify({ ...readVoiceSecrets(), elevenLabsKey: "el-key" }),
      { mode: 0o600 }
    );
    kept.length = 0;
    expect(await voiceStart(paths, o)).toEqual({
      embedder: "running",
      identity: "running",
      quiet: "running",
      server: "restarted",
    });
    expect(kept).toEqual(["voice-server"]);
    const plist = readFileSync(plistOf("voice-server", "", []).path, "utf8");
    for (const v of Object.values(readVoiceSecrets())) {
      expect(plist).not.toContain(String(v));
    }
    kept.length = 0;
    await voiceStart(paths, o);
    expect(kept).toEqual([]);
    // The Claude token's restart: the Mac helper alone.
    await voiceStart(paths, o, "quiet");
    expect(kept).toEqual(["voice-quiet"]);
    kept.length = 0;
    // While Lifelog Host runs voice, nothing starts or stops.
    stopped.length = 0;
    const host = await voiceStart(paths, {
      ...o,
      hostRuns: () => Promise.resolve(true),
    });
    expect(Object.values(host)).toEqual(Array(4).fill(HOST_RUNS));
    expect([kept, stopped]).toEqual([[], []]);
    // A job whose bootstrap failed is not running, whatever its plist.
    await voiceStart(paths, { ...o, loaded: () => Promise.resolve(false) });
    expect(kept).toEqual([
      "voice-server",
      "voice-quiet",
      "voice-identity",
      "voice-embedder",
    ]);
  } finally {
    rmSync(VOICE_SECRETS, { force: true });
    rmSync(support, { force: true, recursive: true });
  }
});

test("a new Life build changes every job's arguments", () => {
  const launch = { args: [], binary: "/app/Helpers/lifelog-quiet", env: {} };
  expect(jobArgsOf("quiet", launch, "b1")).not.toEqual(
    jobArgsOf("quiet", launch, "b2")
  );
  expect(jobArgsOf("quiet", launch, "b1")).toEqual(
    jobArgsOf("quiet", launch, "b1")
  );
});

test("voice run can replace itself with its child", () => {
  expect(typeof process.execve).toBe("function");
});

test("only his own Life's helper reads voice's secrets: a checkout or a second Life puts no token in its pair link and reads with LIFELOG_TOKEN", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    fetch: (req) => {
      seen.push(req.headers.get("authorization") ?? "");
      return Response.json({});
    },
    port: 0,
  });
  const { lifelog } = settings();
  const token = process.env.LIFELOG_TOKEN;
  setSettings({ lifelog: { url: server.url.origin } });
  process.env.LIFELOG_TOKEN = "env-token";
  mkdirSync(dirname(VOICE_SECRETS), { recursive: true });
  writeFileSync(VOICE_SECRETS, JSON.stringify({ deviceToken: "device" }), {
    mode: 0o600,
  });
  try {
    // A test's data is a second Life.
    expect(pairTokenOf(true)).toBeUndefined();
    await call("/status");
    const own = spyOn(platform, "isOwnLife").mockReturnValue(true);
    try {
      // A checkout's `bun life`, his own data or not.
      expect(pairTokenOf()).toBeUndefined();
      expect(pairTokenOf(true)).toBe("device");
      await call("/status");
      chmodSync(VOICE_SECRETS, 0o640);
      await expect(call("/status")).rejects.toThrow("readable by others");
    } finally {
      own.mockRestore();
    }
    expect(seen).toEqual(["Bearer env-token", "Bearer device"]);
    expect(pairLinkOf("https://life.example", "ABC234")).toBe(
      "lifelog://pair?code=ABC234&life=https%3A%2F%2Flife.example"
    );
    expect(pairLinkOf("https://life.example", "ABC234", "tok")).toContain(
      "token=tok&url=https%3A%2F%2Flife.example%2Fvoice"
    );
  } finally {
    rmSync(VOICE_SECRETS, { force: true });
    setSettings({ lifelog });
    if (token === undefined) {
      delete process.env.LIFELOG_TOKEN;
    } else {
      process.env.LIFELOG_TOKEN = token;
    }
    server.stop(true);
  }
});

test("an owner key is set or removed, every other secret kept, the file still owner-only", () => {
  try {
    rmSync(VOICE_SECRETS, { force: true });
    const stored = mintVoiceSecrets();
    setVoiceKey("elevenLabsKey", " el-key\n");
    expect(readVoiceSecrets()).toEqual({ ...stored, elevenLabsKey: "el-key" });
    setVoiceKey("elevenLabsKey", "");
    expect(readVoiceSecrets()).toEqual(stored);
    expect(statSync(VOICE_SECRETS).mode.toString(8)).toEndWith("600");
  } finally {
    rmSync(VOICE_SECRETS, { force: true });
  }
});

test("export and import say how they ended, never raw JSON", () => {
  const done = archiveLineOf(
    "export",
    0,
    'copying audio\n{"ok":true,"files":12,"bytes":2048}\n'
  );
  expect(done).toEqual({ line: "Exported 12 files.", ok: true });
  expect(
    archiveLineOf(
      "import",
      1,
      '{"ok":false,"error":"this install isn\'t empty"}'
    ).line
  ).toBe("The import failed: this install isn't empty");
  expect(archiveLineOf("import", 2, '{"unexpected":1}').line).toBe(
    "The import failed: it stopped with status 2"
  );
  expect(archiveLineOf("export", 1, "error: no space left").line).toEndWith(
    "no space left"
  );
});

test("the status line: what keeps voice from running first, then the wanted children that aren't", () => {
  const up = { state: "running", why: null };
  const all = (
    c: Partial<Record<string, { state: string | null; why: string | null }>>
  ) => ({
    embedder: up,
    identity: up,
    quiet: up,
    server: up,
    ...c,
  });
  expect(voiceLineOf(all({}), true)).toBe("Running");
  expect(
    voiceLineOf(all({ server: { state: null, why: HOST_RUNS } }), false)
  ).toBe(HOST_RUNS);
  expect(
    voiceLineOf(all({ identity: { state: null, why: "off" } }), true)
  ).toBe("Running");
  expect(
    voiceLineOf(all({ embedder: { state: "waiting", why: null } }), true)
  ).toBe("Running; not running: embedder");
  expect(voiceLineOf(all({}), false)).toBe("Not answering");
});
