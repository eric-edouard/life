import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSettings,
  renamedSettings,
  setSettings,
  settings,
} from "./settings";

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

test("the old names (the voice key and source) are renamed where the file is read, once", () => {
  const path = join(mkdtempSync(join(tmpdir(), "life-settings-")), "s.json");
  writeFileSync(
    path,
    JSON.stringify({
      lifelog: { url: "https://voice.example.test" },
      sources: ["lifelog", "agent"],
    })
  );
  expect(readSettings(path)).toMatchObject({
    sources: ["voice", "agent"],
    voice: { url: "https://voice.example.test" },
  });
  const once = readFileSync(path, "utf8");
  expect(JSON.parse(once).lifelog).toBeUndefined();
  readSettings(path);
  expect(readFileSync(path, "utf8")).toBe(once);
  expect(renamedSettings({ sources: ["voice"] })).toEqual({
    sources: ["voice"],
  });
});
