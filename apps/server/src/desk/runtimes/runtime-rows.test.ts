import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME, WINDOWS } from "../../core/platform";
import { CODEX_AGENT_OFF, CODEX_HOME, CODEX_OFF } from "../../models/llm";
import { doorOf } from "../door-keys";
import { SEND_GUARD_HOOK } from "../send-guard";
import {
  isRolloutTurnOpen,
  isSessionOpen,
  readProgram,
  runtimeRowsOf,
} from "./runtime-rows";

// The runtime rows as data: what each program is given, and how each reads a session's state. Made-up transcripts.

// His real login shell never runs in a test: `SHELL` is a made-up one, which sets made-up variables, for the whole file.
const CLAUDE_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
];
const CODEX_KEYS = ["CODEX_API_KEY", "OPENAI_API_KEY"];
const ENGINE_KEYS = [...CLAUDE_KEYS, ...CODEX_KEYS];
// His Codex never runs either: a made-up `codex` first on the PATH answers the app server's `hooks/list` with a made-up hash.
const shellWas = process.env.SHELL;
const pathWas = process.env.PATH;
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "life-login-"));
  const shell = join(dir, "shell.sh");
  const vars = [...ENGINE_KEYS, "LIFE_TEST_LOGIN"].map((k) => `${k}=made-up`);
  writeFileSync(shell, `#!/bin/sh\n${vars.join(" ")} exec sh -c "$2"\n`);
  chmodSync(shell, 0o755);
  process.env.SHELL = shell;
  const answer = JSON.stringify({
    id: 2,
    result: {
      data: [{ hooks: [{ currentHash: "sha256:made-up", key: GUARD_KEY }] }],
    },
  });
  writeFileSync(
    join(dir, "codex"),
    `#!/bin/sh\nwhile read -r l; do case "$l" in *'"id":2'*) echo '${answer}';; esac; done\n`
  );
  chmodSync(join(dir, "codex"), 0o755);
  process.env.PATH = `${dir}:${pathWas}`;
});
afterAll(() => {
  process.env.SHELL = shellWas;
  process.env.PATH = pathWas;
});
const GUARD_KEY = "/<session-flags>/config.toml:pre_tool_use:0:0";

const a = {
  door: doorOf("agt_0123456789ab"),
  effort: null,
  folder: tmpdir(),
  id: "agt_0123456789ab",
  model: null,
  title: "Test",
};

test("the rows put the door's key in the environment, never in a command; each names the adapter, the model and the effort", async () => {
  const spawned = await Promise.all(
    [true, false].flatMap((isOwn) =>
      Object.values(runtimeRowsOf(isOwn)).map((row) =>
        row.spawn({ ...a, effort: "low", model: "test-model" })
      )
    )
  );
  for (const { command, env } of spawned) {
    expect(command[0]).toBe(process.execPath);
    expect(command.join(" ")).not.toContain(a.door.key);
    expect(env.BUN_BE_BUN).toBe("1");
  }
  const { claude, codex } = runtimeRowsOf(true);
  expect((await claude.spawn(a)).env.LIFE_DESK_KEY).toBe(a.door.key);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: what Claude expands from the adapter's environment
  expect(claude.header(a.door.key)).toBe("Bearer ${LIFE_DESK_KEY}");
  expect(codex.header(a.door.key)).toBe(`Bearer ${a.door.key}`);
  expect((await codex.spawn(a)).env.LIFE_DESK_KEY).toBeUndefined();
  expect(
    JSON.parse(
      (await codex.spawn({ ...a, effort: "low", model: "test-model" })).env
        .CODEX_CONFIG ?? ""
    )
  ).toEqual({
    hooks: expect.any(Object),
    model: "test-model",
    model_reasoning_effort: "low",
    shell_environment_policy: {
      ignore_default_excludes: true,
      inherit: "all",
    },
  });
  expect([claude.onlyToolPrefixes, codex.onlyToolPrefixes]).toEqual([
    undefined,
    undefined,
  ]);
  expect([claude.mode, codex.mode]).toEqual(["bypassPermissions", undefined]);
  expect((await codex.spawn(a)).env.INITIAL_AGENT_MODE).toBe(
    "agent-full-access"
  );
  const second = runtimeRowsOf(false);
  expect([
    second.claude.onlyToolPrefixes,
    second.codex.onlyToolPrefixes,
  ]).toEqual([
    ["mcp__desk__", "mcp__life_connector__"],
    ["mcp.desk.", "mcp.life_connector."],
  ]);
  expect([second.claude.mode, second.codex.mode]).toEqual([
    undefined,
    undefined,
  ]);
  expect((await second.codex.spawn(a)).env.INITIAL_AGENT_MODE).toBe(
    "workspace-write"
  );
});

test("a second Life's agent takes none of his settings, tools or instruction files: its door and its reads alone, its turns sent where `ANTHROPIC_BASE_URL` says; his own runs as he set the programs up", async () => {
  const rows = runtimeRowsOf(false);
  expect(rows.claude.meta?.(a)).toMatchObject({
    claudeCode: {
      options: {
        allowedTools: ["mcp__desk", "mcp__life_connector"],
        settingSources: [],
        strictMcpConfig: true,
        tools: [],
      },
    },
  });
  expect(rows.claude.meta?.(a)).toMatchObject({
    claudeCode: { options: { permissionMode: "default" } },
  });
  const { env } = await rows.claude.spawn(a);
  expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
  expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
  try {
    expect((await rows.claude.spawn(a)).env.ANTHROPIC_BASE_URL).toBe(
      "http://127.0.0.1:9"
    );
    expect(
      (await runtimeRowsOf(true).claude.spawn(a)).env.ANTHROPIC_BASE_URL
    ).toBeUndefined();
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
  }
  const second = JSON.parse((await rows.codex.spawn(a)).env.CODEX_CONFIG ?? "");
  expect(second.project_doc_max_bytes).toBe(0);
  for (const f of [...CODEX_OFF, ...CODEX_AGENT_OFF]) {
    expect(second.features[f]).toBe(false);
  }
  expect(second.web_search).toBe("disabled");
  expect(second.skills.include_instructions).toBe(false);
  expect((await rows.codex.spawn(a)).env.CODEX_HOME).toBe(CODEX_HOME);
  const his = runtimeRowsOf(true);
  expect(
    (await his.claude.spawn(a)).env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  ).toBeUndefined();
  expect((await his.codex.spawn(a)).env.CODEX_HOME).toBeUndefined();
});

test("his login shell's environment goes to his own Life's agents only, less the runtime's engine keys; a second Life's gets none of it", async () => {
  const own = runtimeRowsOf(true);
  const claude = (await own.claude.spawn(a)).env;
  const codex = (await own.codex.spawn(a)).env;
  expect(claude.LIFE_TEST_LOGIN).toBe("made-up");
  expect(codex.LIFE_TEST_LOGIN).toBe("made-up");
  // Each runtime keeps the other's keys and loses its own.
  for (const k of CLAUDE_KEYS) {
    expect(claude[k]).toBeUndefined();
    expect(codex[k]).toBe("made-up");
  }
  for (const k of CODEX_KEYS) {
    expect(codex[k]).toBeUndefined();
    expect(claude[k]).toBe("made-up");
  }
  const seconds = await Promise.all(
    Object.values(runtimeRowsOf(false)).map((row) => row.spawn(a))
  );
  for (const { env } of seconds) {
    expect(env.LIFE_TEST_LOGIN).toBeUndefined();
    for (const k of ENGINE_KEYS) {
      expect(env[k]).toBeUndefined();
    }
  }
});

test("a claude session is running while Claude's own record names a live process, even between his turns", async () => {
  const ref = `ref-${crypto.randomUUID()}`;
  // His last turn ended: the case the desk once took for idle and resumed beside his app.
  const projects = join(HOME, ".claude", "projects", "made-up");
  mkdirSync(projects, { recursive: true });
  writeFileSync(
    join(projects, `${ref}.jsonl`),
    `${JSON.stringify({ message: { content: [{ type: "text" }], stop_reason: "end_turn" }, type: "assistant" })}\n`
  );
  const records = join(HOME, ".claude", "sessions");
  mkdirSync(records, { recursive: true });
  const record = (pid: number) =>
    writeFileSync(
      join(records, `${pid}.json`),
      JSON.stringify({ pid, sessionId: ref })
    );
  // Made-up processes: `sh -c` shows its next word in the command line (`; :` keeps sh alive).
  const sleeper = (word: string) =>
    Bun.spawn(["sh", "-c", "sleep 30; :", word]);
  const app = sleeper("made-up-app");
  const others = [
    sleeper(`made-up/other --resume=${ref}`),
    sleeper(`/made-up/${ref}/serve.ts`),
  ];
  const row = runtimeRowsOf(false).claude;
  try {
    record(app.pid);
    expect(await row.readSessionState(ref)).toBe("running");
    app.kill();
    await app.exited;
    // A stale record: its process is gone. Neither a non-Claude flag nor a path holds it.
    expect(await isSessionOpen(ref)).toBe(false);
    expect(await row.readSessionState(ref)).toBe("idle");
    expect(await row.readSessionState(`ref-${crypto.randomUUID()}`)).toBe(
      "gone"
    );
  } finally {
    for (const p of [app, ...others]) {
      p.kill();
    }
  }
});

test("a Claude command line resuming the session holds it with no record", async () => {
  const ref = `ref-${crypto.randomUUID()}`;
  const resumed = Bun.spawn([
    "sh",
    "-c",
    "sleep 30; :",
    `made-up/claude --resume ${ref}`,
  ]);
  try {
    expect(await isSessionOpen(ref)).toBe(true);
  } finally {
    resumed.kill();
  }
});

test("a codex session is running while its rollout's last turn is open and fresh (his own turn in the app); a compressed rollout is not gone", async () => {
  const dir = join(CODEX_HOME, "sessions", "2026", "01", "01");
  mkdirSync(dir, { recursive: true });
  const ev = (type: string) =>
    JSON.stringify({ payload: { type }, type: "event_msg" });
  const write = (ref: string, ext: string, lines: string[], ageMin: number) => {
    const path = join(dir, `rollout-2026-01-01T00-00-00-${ref}.${ext}`);
    const text = `${lines.join("\n")}\n`;
    writeFileSync(
      path,
      ext.endsWith("zst") ? Bun.zstdCompressSync(text) : text
    );
    const at = new Date(Date.now() - ageMin * 60_000);
    utimesSync(path, at, at);
  };
  expect(isRolloutTurnOpen([ev("task_started")])).toBe(true);
  expect(isRolloutTurnOpen([ev("task_started"), ev("task_complete")])).toBe(
    false
  );
  expect(isRolloutTurnOpen([ev("task_started"), ev("turn_aborted")])).toBe(
    false
  );
  write("ref-open-fresh", "jsonl", [ev("task_started")], 1);
  write("ref-open-stale", "jsonl", [ev("task_started")], 30);
  write("ref-done", "jsonl", [ev("task_started"), ev("task_complete")], 1);
  write(
    "ref-packed",
    "jsonl.zst",
    [ev("task_started"), ev("task_complete")],
    20_000
  );
  write("ref-half", "jsonl", [ev("task_started"), '{"type":"event_ms'], 1);
  const row = runtimeRowsOf(false).codex;
  expect(await row.readSessionState("ref-open-fresh")).toBe("running");
  expect(await row.readSessionState("ref-open-stale")).toBe("idle");
  expect(await row.readSessionState("ref-done")).toBe("idle");
  expect(await row.readSessionState("ref-packed")).toBe("idle");
  expect(await row.readSessionState("ref-none")).toBe("gone");
  // A half-written last line never throws.
  expect(await row.readSessionState("ref-half")).toBe("running");
  // A rollout that can't be read is not idle: its state is unknown (a runtime switch waits on it).
  writeFileSync(
    join(dir, "rollout-2026-01-01T00-00-00-ref-broken.jsonl.zst"),
    "not zstd"
  );
  await expect(row.readSessionState("ref-broken")).rejects.toThrow();
});

test("the desk launches the program on the PATH, never one in node_modules/.bin (Life's pinned Codex under `bun run`)", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-path-"));
  const pinned = join(dir, "node_modules", ".bin");
  const his = join(dir, "his");
  for (const d of [pinned, his]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "codex"), "#!/bin/sh\n");
    chmodSync(join(d, "codex"), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${pinned}:${his}:${path}`;
  try {
    expect(readProgram("codex")).toBe(join(his, "codex"));
  } finally {
    process.env.PATH = path;
  }
});

test("his own Life's agents run the send guard before each shell and MCP call, Codex's trusted by the hash his Codex gives; a second Life's run none", async () => {
  const own = runtimeRowsOf(true);
  const hook = {
    PreToolUse: [
      {
        hooks: [{ command: SEND_GUARD_HOOK.command, type: "command" }],
        matcher: SEND_GUARD_HOOK.matcher,
      },
    ],
  };
  expect(own.claude.meta?.(a)).toEqual({
    claudeCode: {
      options: { extraArgs: { name: a.title }, settings: { hooks: hook } },
    },
  });
  const [codex, claude] = await Promise.all([
    own.codex.spawn(a),
    own.claude.spawn(a),
  ]);
  expect(JSON.parse(codex.env.CODEX_CONFIG ?? "").hooks).toEqual({
    ...hook,
    state: { [GUARD_KEY]: { trusted_hash: "sha256:made-up" } },
  });
  for (const { env } of [codex, claude]) {
    expect(existsSync(env.LIFE_SEND_GUARD ?? "")).toBe(true);
    expect(env.LIFE_BUN).toBe(process.execPath);
    expect(JSON.parse(env.LIFE_SEND_FACTS ?? "")).toMatchObject({
      postRepos: [],
    });
  }
  const second = runtimeRowsOf(false);
  expect(JSON.stringify(second.claude.meta?.(a))).not.toContain("hooks");
  const seconds = await Promise.all(
    Object.values(second).map((row) => row.spawn(a))
  );
  for (const { env } of seconds) {
    expect(env.LIFE_SEND_FACTS).toBeUndefined();
    expect(JSON.parse(env.CODEX_CONFIG ?? "{}").hooks).toBeUndefined();
  }
});

test("only his own Life's Claude row lists its sessions in his Claude app (his ask of 26 Nov 2026); a second Life's never does", () => {
  for (const isOwn of [true, false]) {
    const rows = runtimeRowsOf(isOwn);
    expect(Boolean(rows.claude.listInApp)).toBe(isOwn && !WINDOWS);
    expect(rows.codex.listInApp).toBeUndefined();
  }
});
