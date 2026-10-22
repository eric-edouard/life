import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_DIR } from "../core/log";
import { LIFE_CODE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { MACHINE_DIR, MODEL_ENV } from "../core/platform";
import { repoFiles } from "../core/proc";
import {
  askOnce,
  claudeTokens,
  codexTokens,
  extractJson,
  llmFor,
  llmOverride,
  quota,
  quotaOf,
  type Tools,
} from "./llm";

test("a model reply: bare or fenced JSON, and a self-correction's last object wins", () => {
  expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  expect(extractJson('Here:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  expect(
    extractJson(
      '```json\n{"a": 1}\n```\n\nCorrection: `a` is wrong.\n\n```json\n{"a": 2}\n```'
    )
  ).toEqual({ a: 2 });
  expect(() => extractJson("no json")).toThrow();
});

test("LIFE_LLM: engine/model[/effort] on a copy of the data, refused on his own", () => {
  const copy = mkdtempSync(join(tmpdir(), "life-copy-"));
  expect(llmOverride(undefined, copy)).toBeUndefined();
  expect(llmOverride("claude/opus/medium", copy)).toEqual({
    effort: "medium",
    engine: "claude",
    model: "opus",
  });
  expect(
    llmOverride("openrouter/xiaomi/mimo-v2.6-pro@deepinfra/high", copy)
  ).toEqual({
    effort: "high",
    engine: "openrouter",
    model: "xiaomi/mimo-v2.6-pro@deepinfra",
  });
  expect(llmOverride("openrouter/x/y", copy)).toEqual({
    effort: undefined,
    engine: "openrouter",
    model: "x/y",
  });
  expect(() => llmOverride("opus", copy)).toThrow();
  expect(() => llmOverride("gemini/x", copy)).toThrow();
  expect(() =>
    llmOverride("codex/gpt-6.1-sol", join(homedir(), "Life"))
  ).toThrow("never ~/Life");
});

test("openrouter: pinned, zero retention, no fallback; another host, a cut reply or an error is refused", async () => {
  const asked: Record<string, unknown>[] = [];
  let reply: { finish: string; provider: string; status: number } = {
    finish: "stop",
    provider: "DeepInfra",
    status: 200,
  };
  const fetched = spyOn(globalThis, "fetch").mockImplementation(((
    _url: string,
    init: RequestInit
  ) => {
    asked.push(JSON.parse(String(init.body)));
    return Promise.resolve(
      Response.json(
        {
          choices: [
            {
              finish_reason: reply.finish,
              message: { content: '{"ok": true}' },
            },
          ],
          provider: reply.provider,
          usage: { cost: 0.01 },
        },
        { status: reply.status }
      )
    );
  }) as unknown as typeof fetch);
  process.env.OPENROUTER_API_KEY = "test-key";
  const ask = () =>
    askOnce({
      dir: mkdtempSync(join(tmpdir(), "life-or-")),
      input: { a: 1 },
      llm: { effort: "high", engine: "openrouter", model: "x/y@deepinfra" },
      prompt: "eval-judge.v1",
      run: "r",
    });
  try {
    expect(await ask()).toEqual({ ok: true });
    expect(asked[0]?.model).toBe("x/y");
    expect(asked[0]?.provider).toEqual({
      allow_fallbacks: false,
      data_collection: "deny",
      only: ["deepinfra"],
      quantizations: ["fp8"],
      require_parameters: true,
      zdr: true,
    });
    reply = { ...reply, provider: "Novita" };
    await expect(ask()).rejects.toThrow("served by Novita");
    // Refused, yet billed: its cost is in the log.
    const today = join(
      LOG_DIR,
      `${new Date().toISOString().slice(0, 10)}.jsonl`
    );
    const last = readFileSync(today, "utf8").trim().split("\n").at(-1);
    expect(last).toContain("served by Novita");
    expect(last).toContain('"costUsd":0.01');
    reply = { ...reply, finish: "length", provider: "DeepInfra" };
    await expect(ask()).rejects.toThrow("stopped (length)");
    reply = { ...reply, status: 429 };
    await expect(ask()).rejects.toThrow("openrouter 429");
  } finally {
    fetched.mockRestore();
    delete process.env.OPENROUTER_API_KEY;
  }
});

/** What one model CLI was started with. */
interface Run {
  argv: string[];
  cwd: string;
  /** Its folder had nothing in it. */
  empty: boolean;
  env: Record<string, string>;
}

/** One claude call then one codex call, each CLI faked where it is spawned, with secrets in the environment. */
async function spawnBoth(tools?: Tools) {
  const runs: Run[] = [];
  const spawned = spyOn(Bun, "spawn").mockImplementation(((
    argv: string[],
    o: { cwd: string; env: Record<string, string> }
  ) => {
    runs.push({
      argv,
      cwd: o.cwd,
      empty: readdirSync(o.cwd).length === 0,
      env: o.env,
    });
    // Codex writes its reply to `-o`, claude streams events with the result last.
    if (argv.includes("-o")) {
      writeFileSync(argv[argv.indexOf("-o") + 1] as string, '{"ok": true}');
    }
    const result = { is_error: false, result: '{"ok": true}', type: "result" };
    return {
      exited: Promise.resolve(0),
      signalCode: null,
      stderr: new Response("").body,
      stdout: Response.json(result).body,
    };
  }) as unknown as typeof Bun.spawn);
  // Codex's own login, wherever its home is.
  const { file } = Bun;
  const files = spyOn(Bun, "file").mockImplementation(((p: string) =>
    file(p.endsWith("auth.json") ? import.meta.path : p)) as typeof Bun.file);
  const env = { ...process.env };
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LIFELOG_TOKEN"]) {
    process.env[k] = "secret";
  }
  try {
    for (const engine of ["claude", "codex"] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one call, then the other
      const reply = await askOnce({
        dir: mkdtempSync(join(tmpdir(), "life-flags-")),
        input: { a: 1 },
        llm: { engine, model: "m" },
        prompt: "eval-judge.v1",
        run: "r",
        tools,
      });
      expect(reply).toEqual({ ok: true });
    }
  } finally {
    spawned.mockRestore();
    files.mockRestore();
    process.env = env;
  }
  expect(runs).toHaveLength(2);
  return runs as [Run, Run];
}

const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
const inside = (dir: string, root: string) => `${dir}/`.startsWith(`${root}/`);

test("a model call has no tools, no MCP, no settings, no secrets, and runs in an empty folder outside the repo and his data", async () => {
  const [claude, codex] = await spawnBoth();
  expect(claude.argv[0]).toBe("claude");
  expect(after(claude.argv, "--tools")).toBe("");
  expect(claude.argv).toContain("--strict-mcp-config");
  expect(after(claude.argv, "--setting-sources")).toBe("");
  expect(after(codex.argv, "-s")).toBe("read-only");
  expect(after(codex.argv, "-C")).toBe(codex.cwd);
  for (const tool of ["shell_tool", "unified_exec", "code_mode_host"]) {
    expect(codex.argv[codex.argv.indexOf(tool) - 1]).toBe("--disable");
  }
  expect(codex.argv.join(" ")).not.toContain("mcp_servers");
  expect(codex.argv).toEqual(
    expect.arrayContaining([
      "--ignore-user-config",
      "--ignore-rules",
      "project_doc_max_bytes=0",
      'web_search="disabled"',
    ])
  );
  // The allowed names carry no secret, whatever the system adds to them.
  const allowed = MODEL_ENV;
  expect(allowed.filter((k) => SECRETISH.test(k))).toEqual([]);
  expect(allowed).toEqual(expect.arrayContaining(Object.keys(claude.env)));
  expect([...allowed, "CODEX_HOME"]).toEqual(
    expect.arrayContaining(Object.keys(codex.env))
  );
  // Its own home, so ~/.codex/AGENTS.md never reaches the model.
  expect(codex.env.CODEX_HOME).toBe(join(MACHINE_DIR, "codex"));
  for (const r of [claude, codex]) {
    expect(r.empty).toBe(true);
    for (const root of [
      LIFE_CODE_DIR,
      OWNER_DATA_DIR,
      join(homedir(), "Life"),
    ]) {
      expect(inside(r.cwd, root)).toBe(false);
    }
  }
});

const SECRETISH = /KEY|TOKEN|SECRET/i;

/** How code could start a model CLI: an argv or a shell command that begins with one, or Codex's pinned binary. */
const STARTS_MODEL = [
  /\[\s*["'`][^"'`]*\b(?:claude|codex)["'`]/,
  /\$`\s*\S*\b(?:claude|codex)\b/,
  /\bCODEX(?:_BIN)?\b/,
];
const RUNS_PROGRAMS = /Bun\.spawn|Bun\.\$|\bexec\(|spawnSync|child_process/;

test("only llm.ts starts the model CLIs", async () => {
  const code = repoFiles(
    LIFE_CODE_DIR,
    ["apps/server/src", "scripts"],
    [".ts"]
  ).filter((f) => !f.endsWith(".test.ts"));
  const texts = await Promise.all(
    code.map((f) => Bun.file(join(LIFE_CODE_DIR, f)).text())
  );
  expect(
    code.filter(
      (_, i) =>
        RUNS_PROGRAMS.test(texts[i] ?? "") &&
        STARTS_MODEL.some((p) => p.test(texts[i] ?? ""))
    )
  ).toEqual(["apps/server/src/models/llm.ts"]);
});

test("the Codex quota: the fuller window and its reset; no window or no answer is none", () => {
  const limits = (primary: unknown, secondary: unknown = null) =>
    JSON.stringify({ id: 2, result: { rateLimits: { primary, secondary } } });
  expect(
    quotaOf(
      limits(
        {
          resetsAt: 1_793_085_398,
          usedPercent: 91,
          windowDurationMins: 10_080,
        },
        { resetsAt: null, usedPercent: 40 }
      )
    )
  ).toEqual({ resetsAt: "2026-10-27T07:16:38.000Z", used: 91 });
  expect(quotaOf(limits({ usedPercent: 10 }, { usedPercent: 60 }))).toEqual({
    resetsAt: null,
    used: 60,
  });
  expect(quotaOf(limits(null))).toBeUndefined();
  expect(quotaOf('{"error":{"message":"no"},"id":2}')).toBeUndefined();
  expect(quotaOf(undefined)).toBeUndefined();
});

test("the bench's one call with tools: Life's connector only, read-only; codex keeps code mode, the way to MCP tools, and no shell", async () => {
  const tools = {
    command: ["bun", "serve.ts"],
    env: { LIFE_NOW: "2026-10-14T10:00:00Z" },
  };
  const [claude, codex] = await spawnBoth(tools);
  expect(after(claude.argv, "--tools")).toBe("");
  expect(after(claude.argv, "--allowedTools")).toBe("mcp__life");
  expect(
    Object.keys(
      JSON.parse(after(claude.argv, "--mcp-config") ?? "{}").mcpServers
    )
  ).toEqual(["life"]);
  expect(after(codex.argv, "-s")).toBe("read-only");
  for (const tool of ["shell_tool", "unified_exec", "sleep_tool"]) {
    expect(codex.argv[codex.argv.indexOf(tool) - 1]).toBe("--disable");
  }
  expect(codex.argv).not.toContain("code_mode_host");
  expect(codex.argv).not.toContain(
    "--dangerously-bypass-approvals-and-sandbox"
  );
  expect(
    codex.argv
      .filter((a) => a.startsWith("mcp_servers."))
      .every((a) => a.startsWith("mcp_servers.life."))
  ).toBe(true);
});

test("codex's tokens: each turn.completed's usage, summed; other lines ignored", () => {
  const turn = (input: number, cached: number, output: number) =>
    JSON.stringify({
      type: "turn.completed",
      usage: {
        cached_input_tokens: cached,
        input_tokens: input,
        output_tokens: output,
        reasoning_output_tokens: 0,
      },
    });
  const events = [
    '{"type":"thread.started","thread_id":"t"}',
    turn(21_195, 12_288, 9),
    "not json",
    turn(5, 0, 1),
    "",
  ].join("\n");
  expect(codexTokens(events)).toEqual({
    cached: 12_288,
    input: 21_200,
    output: 10,
  });
  expect(codexTokens("")).toEqual({ cached: 0, input: 0, output: 0 });
});

test("claude's tokens: input counts its cache reads and writes, as codex's does", () => {
  expect(
    claudeTokens({
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 200,
      input_tokens: 5,
      output_tokens: 7,
    })
  ).toEqual({ cached: 200, input: 235, output: 7 });
});

test("each provider's model and effort by tier; tools only on his subscriptions", async () => {
  expect(llmFor("deep", "anthropic")).toEqual({
    effort: "high",
    engine: "anthropic",
    model: "claude-opus-5-5",
  });
  expect(llmFor("fast", "claude")).toEqual({
    effort: undefined,
    engine: "claude",
    model: "haiku",
  });
  expect(llmFor("main", "openai").model).toBe(llmFor("main", "codex").model);
  await expect(
    askOnce({
      dir: mkdtempSync(join(tmpdir(), "life-llm-")),
      input: {},
      llm: llmFor("main", "openai"),
      prompt: "files.v1",
      run: "test",
      tools: { command: [], env: {} },
    })
  ).rejects.toThrow("runs no tools");
});

test("only a provider with a quota reads one: a Claude run reads none, whatever his setting", async () => {
  expect(await quota("claude")).toBeUndefined();
  expect(await quota("anthropic")).toBeUndefined();
});
