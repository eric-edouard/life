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
  hasQuota,
  llmFor,
  llmOverride,
  quota,
  quotaOf,
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
    llmOverride("allmodels/z-ai/glm-5.3-abliterated@abliteration/high", copy)
  ).toEqual({
    effort: "high",
    engine: "allmodels",
    model: "z-ai/glm-5.3-abliterated@abliteration",
  });
  expect(llmOverride("allmodels/x/y", copy)).toEqual({
    effort: undefined,
    engine: "allmodels",
    model: "x/y",
  });
  expect(() => llmOverride("opus", copy)).toThrow();
  expect(() => llmOverride("gemini/x", copy)).toThrow();
  expect(() =>
    llmOverride("codex/gpt-6.1-sol", join(homedir(), "Life"))
  ).toThrow("never ~/Life");
});

test("allmodels: only his hosts, one at a time in his order, streamed; a host cut mid-reply, a garbled reply, a 429 or a 5xx gives way to the next, every host's tokens logged; another host, an unnamed one, a cut reply or an error is refused", async () => {
  const asked: { body: Record<string, unknown>; url: string }[] = [];
  let reply: {
    finish?: string;
    provider?: string;
    status: number;
    /** The hosts whose stream ends before it finishes (29 Oct 2026: refuseless on 16 Oct). */
    cut?: string[];
    /** The hosts that put a stray word in their reply (5 Nov 2026: refuseless on 21 Oct). */
    garbled?: string[];
    /** The connection stays open after [DONE]. */
    open?: boolean;
  } = { finish: "stop", provider: "Refuseless", status: 200 };
  // Sent in small pieces with CRLF line ends, so an event is split across pieces.
  const sse = (chunks: unknown[]) => {
    const text = `: keepalive\r\n${chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("")}data: [DONE]\r\n\r\n`;
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) {
          c.enqueue(bytes.slice(i, i + 7));
        }
        if (!reply.open) {
          c.close();
        }
      },
    });
  };
  const usage = (output: number) => ({
    completion_tokens: output,
    prompt_tokens: 30,
    prompt_tokens_details: { cached_tokens: 20 },
  });
  const fetched = spyOn(globalThis, "fetch").mockImplementation(((
    url: string,
    init: RequestInit
  ) => {
    const body = JSON.parse(String(init.body));
    asked.push({ body, url });
    const [host] = body.provider.only;
    const opened = {
      choices: [{ delta: { content: "", role: "assistant" } }],
      provider: reply.provider,
    };
    const chunks = reply.cut?.includes(host)
      ? [opened, { provider: reply.provider, usage: usage(3) }]
      : [
          opened,
          {
            choices: [{ delta: { content: '{"ok":' } }],
            provider: reply.provider,
          },
          {
            choices: [
              {
                delta: {
                  content: reply.garbled?.includes(host) ? " 继续}" : " true}",
                },
                finish_reason: reply.finish,
              },
            ],
            provider: reply.provider,
          },
          { choices: [], provider: reply.provider, usage: usage(7) },
        ];
    return Promise.resolve(
      new Response(reply.status === 200 ? sse(chunks) : "slow down", {
        status: reply.status,
      })
    );
  }) as unknown as typeof fetch);
  process.env.ALLMODELS_API_KEY = "test-key";
  const ask = () =>
    askOnce({
      dir: mkdtempSync(join(tmpdir(), "life-chat-")),
      input: { a: 1 },
      llm: {
        effort: "high",
        engine: "allmodels",
        model: "x/y@refuseless,hopper",
      },
      prompt: "eval-judge.v2",
      run: "r",
    });
  const lastLine = () =>
    readFileSync(
      join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`),
      "utf8"
    )
      .trim()
      .split("\n")
      .at(-1);
  try {
    expect(await ask()).toEqual({ ok: true });
    expect(asked[0]?.url).toContain("api.allmodels.io");
    expect(asked[0]?.body.model).toBe("x/y");
    expect(asked[0]?.body.reasoning_effort).toBe("high");
    expect(asked[0]?.body.stream).toBe(true);
    expect(asked[0]?.body.provider).toEqual({
      allow_fallbacks: false,
      only: ["refuseless"],
      order: ["refuseless"],
    });
    expect(asked).toHaveLength(1);
    expect(lastLine()).toContain(
      '"tokens":{"cached":20,"input":30,"output":7}'
    );
    // Done is done, even when the connection stays open.
    reply = { ...reply, open: true };
    expect(await ask()).toEqual({ ok: true });
    reply = { ...reply, open: false };
    const hostsAsked = () => {
      const list = asked.map(
        (a) => (a.body.provider as { only: string[] }).only[0]
      );
      asked.length = 0;
      return list;
    };
    hostsAsked();
    // The first host opens its reply, then its stream ends: the next host is asked, and both cost.
    reply = { ...reply, cut: ["refuseless"], provider: "Hopper" };
    expect(await ask()).toEqual({ ok: true });
    expect(hostsAsked()).toEqual(["refuseless", "hopper"]);
    expect(lastLine()).toContain(
      '"tokens":{"cached":40,"input":60,"output":10}'
    );
    reply = { ...reply, cut: ["refuseless", "hopper"] };
    await expect(ask()).rejects.toThrow(
      "refuseless: allmodels: stopped (cut before it finished); hopper: allmodels: stopped (cut before it finished)"
    );
    hostsAsked();
    // A finished reply that is not JSON goes to the next host too.
    reply = { ...reply, cut: [], garbled: ["refuseless"] };
    expect(await ask()).toEqual({ ok: true });
    expect(hostsAsked()).toEqual(["refuseless", "hopper"]);
    reply = { ...reply, garbled: ["refuseless", "hopper"] };
    await expect(ask()).rejects.toThrow("hopper: allmodels: not JSON");
    hostsAsked();
    reply = { ...reply, garbled: [], provider: "Experiential Labs" };
    await expect(ask()).rejects.toThrow("served by Experiential Labs");
    // Refused, yet spent: its tokens are in the log.
    expect(lastLine()).toContain("served by Experiential Labs");
    expect(lastLine()).toContain('"input":30');
    // What another host would answer the same way is final.
    expect(hostsAsked()).toEqual(["refuseless"]);
    reply = { ...reply, finish: "length", provider: "Hopper" };
    await expect(ask()).rejects.toThrow("stopped (length)");
    expect(hostsAsked()).toEqual(["refuseless"]);
    reply = { ...reply, status: 401 };
    await expect(ask()).rejects.toThrow("allmodels 401");
    expect(hostsAsked()).toEqual(["refuseless"]);
    reply = { ...reply, status: 429 };
    await expect(ask()).rejects.toThrow("hopper: allmodels 429");
    expect(hostsAsked()).toEqual(["refuseless", "hopper"]);
    reply = { finish: "stop", status: 200 };
    await expect(ask()).rejects.toThrow("served by an unnamed host");
    await expect(
      askOnce({
        dir: mkdtempSync(join(tmpdir(), "life-chat-")),
        input: {},
        llm: { engine: "allmodels", model: "x/y@" },
        prompt: "eval-judge.v2",
        run: "r",
      })
    ).rejects.toThrow("author/model@host[,host]");
  } finally {
    fetched.mockRestore();
    delete process.env.ALLMODELS_API_KEY;
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
  for (const k of ["ALLMODELS_API_KEY", "LIFELOG_TOKEN"]) {
    process.env[k] = "secret";
  }
  try {
    for (const engine of ["claude", "codex"] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: one call, then the other
      const reply = await askOnce({
        dir: mkdtempSync(join(tmpdir(), "life-flags-")),
        input: { a: 1 },
        llm: { engine, model: "m" },
        prompt: "eval-judge.v2",
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

test("each provider's model and effort by tier", () => {
  // Regression (28 Oct 2026): allmodels' hosts refuse "medium", which the pages tier used to send.
  for (const tier of ["deep", "main", "fast"] as const) {
    expect(["none", "low", "high", "max"]).toContain(
      llmFor(tier, "allmodels").effort ?? ""
    );
  }
  expect(llmFor("deep", "allmodels")).toEqual({
    effort: "low",
    engine: "allmodels",
    model: "deepseek/deepseek-v4.1-flash-abliterated@refuseless,hopper",
  });
  expect(llmFor("fast", "claude")).toEqual({
    effort: undefined,
    engine: "claude",
    model: "haiku",
  });
});

test("only a provider with a quota reads one: a Claude run reads none, whatever his setting", async () => {
  expect(await quota("claude")).toBeUndefined();
  expect(await quota("allmodels")).toBeUndefined();
  expect(hasQuota("codex")).toBe(true);
  expect(hasQuota("allmodels")).toBe(false);
});
