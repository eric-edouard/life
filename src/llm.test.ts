import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { askOnce, extractJson, llmOverride, readEngine } from "./llm";
import { LOG_DIR } from "./log";
import { DATA, ROOT } from "./truth";

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

test("a corrupt settings file throws instead of switching engine; a missing one is the default", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "life-settings-")),
    "settings.json"
  );
  expect(readEngine(path)).toBe("claude");
  writeFileSync(path, '{"engine": "co');
  expect(() => readEngine(path)).toThrow();
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
  env: string[];
}

/** One claude call then one codex call, each CLI faked where it is spawned, with secrets in the environment. */
async function spawnBoth() {
  const runs: Run[] = [];
  const spawned = spyOn(Bun, "spawn").mockImplementation(((
    argv: string[],
    o: { cwd: string; env: Record<string, string> }
  ) => {
    runs.push({
      argv,
      cwd: o.cwd,
      empty: readdirSync(o.cwd).length === 0,
      env: Object.keys(o.env),
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
  expect(codex.argv).toEqual(
    expect.arrayContaining([
      "--ignore-user-config",
      "--ignore-rules",
      "project_doc_max_bytes=0",
      'web_search="disabled"',
    ])
  );
  const allowed = "HOME LANG LC_ALL LOGNAME PATH SHELL TERM TMPDIR USER".split(
    " "
  );
  expect(allowed).toEqual(expect.arrayContaining(claude.env));
  expect([...allowed, "CODEX_HOME"]).toEqual(expect.arrayContaining(codex.env));
  for (const r of [claude, codex]) {
    expect(r.empty).toBe(true);
    for (const root of [ROOT, DATA, join(homedir(), "Life")]) {
      expect(inside(r.cwd, root)).toBe(false);
    }
  }
});

/** How code could start a model CLI: an argv or a shell command that begins with one, or Codex's pinned binary. */
const STARTS_MODEL = [
  /\[\s*["'`][^"'`]*\b(?:claude|codex)["'`]/,
  /\$`\s*\S*\b(?:claude|codex)\b/,
  /codex-darwin/,
];
const RUNS_PROGRAMS = /Bun\.spawn|Bun\.\$|\bexec\(|spawnSync|child_process/;

test("only llm.ts starts the model CLIs", async () => {
  const starters: string[] = [];
  for await (const f of new Bun.Glob("{src,scripts}/**/*.ts").scan(ROOT)) {
    const code = await Bun.file(join(ROOT, f)).text();
    if (
      !f.endsWith(".test.ts") &&
      RUNS_PROGRAMS.test(code) &&
      STARTS_MODEL.some((p) => p.test(code))
    ) {
      starters.push(f);
    }
  }
  expect(starters).toEqual(["src/llm.ts"]);
});
