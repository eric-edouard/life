import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractJson, readEngine } from "./llm";

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
