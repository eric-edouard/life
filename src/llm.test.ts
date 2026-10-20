import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { askOnce, extractJson, llmOverride, readEngine } from "./llm";

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
  expect(() => llmOverride("opus", copy)).toThrow();
  expect(() => llmOverride("gemini/x", copy)).toThrow();
  expect(() =>
    llmOverride("codex/gpt-6.1-sol", join(homedir(), "Life"))
  ).toThrow("never ~/Life");
});

test("openrouter: pinned, zero retention, no fallback; another host is refused", async () => {
  const asked: Record<string, unknown>[] = [];
  let served = "DeepInfra";
  const server = Bun.serve({
    async fetch(req) {
      asked.push((await req.json()) as Record<string, unknown>);
      return Response.json({
        choices: [{ message: { content: '{"ok": true}' } }],
        provider: served,
        usage: { cost: 0.01 },
      });
    },
    port: 0,
  });
  process.env.OPENROUTER_URL = `http://localhost:${server.port}`;
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
      zdr: true,
    });
    served = "Novita";
    await expect(ask()).rejects.toThrow("served by Novita");
  } finally {
    server.stop(true);
    delete process.env.OPENROUTER_URL;
    delete process.env.OPENROUTER_API_KEY;
  }
});
