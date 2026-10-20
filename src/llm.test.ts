import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { extractJson, llmOverride, readEngine } from "./llm";

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
  expect(() => llmOverride("opus", copy)).toThrow();
  expect(() => llmOverride("gemini/x", copy)).toThrow();
  expect(() =>
    llmOverride("codex/gpt-6.1-sol", join(homedir(), "Life"))
  ).toThrow("never ~/Life");
});
