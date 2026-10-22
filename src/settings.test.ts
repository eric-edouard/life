import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, setSettings, settings } from "./settings";

test("a corrupt settings file throws instead of switching engine; a missing one is every default", () => {
  const path = join(mkdtempSync(join(tmpdir(), "life-settings-")), "s.json");
  expect(readSettings(path)).toEqual({
    engine: "claude",
    reports: [],
    sources: [],
  });
  writeFileSync(path, '{"engine": "co');
  expect(() => readSettings(path)).toThrow();
});

test("setSettings changes one part and keeps the others", () => {
  const before = readSettings();
  try {
    setSettings({ engine: "codex" });
    expect(readSettings()).toEqual({ ...before, engine: "codex" });
    expect(settings().engine).toBe("codex");
  } finally {
    setSettings({ engine: before.engine });
  }
});

test("settings set with one bad part writes nothing", () => {
  const before = readSettings();
  expect(() =>
    setSettings({ engine: "codex", sources: ["nowhere"] as never })
  ).toThrow();
  expect(readSettings()).toEqual(before);
});
