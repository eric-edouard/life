import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { askOnce, extractJson, llmOverride, quotaOf, readEngine } from "./llm";
import { LOG_DIR } from "./log";

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
  expect(quotaOf('{"id":2,"error":{"message":"no"}}')).toBeUndefined();
  expect(quotaOf(undefined)).toBeUndefined();
});
