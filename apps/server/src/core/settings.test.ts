import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, Settings, setSettings, settings } from "./settings";

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

test("two agents may not share a wake or misheard word, whatever its case and punctuation", () => {
  const agents = (comet: string[]) => ({
    agents: {
      Comet: { wake: comet },
      Orbit: { misheard: ["or bit"], wake: ["orbit"] },
    },
  });
  expect(Settings.safeParse(agents(["comet"])).success).toBe(true);
  expect(Settings.safeParse(agents(["Orbit!"])).success).toBe(false);
  expect(Settings.safeParse(agents(["or-bit"])).success).toBe(false);
});
