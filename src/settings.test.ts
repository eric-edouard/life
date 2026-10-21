import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, setSetting, settings } from "./settings";

test("a corrupt settings file throws instead of switching engine; a missing one is every default", () => {
  const path = join(mkdtempSync(join(tmpdir(), "life-settings-")), "s.json");
  expect(readSettings(path)).toEqual({ engine: "claude", reports: [] });
  writeFileSync(path, '{"engine": "co');
  expect(() => readSettings(path)).toThrow();
});

test("setSetting changes one part and keeps the others", async () => {
  const before = readSettings();
  try {
    await setSetting("engine", "codex");
    expect(readSettings()).toEqual({ ...before, engine: "codex" });
    expect(settings().engine).toBe("codex");
  } finally {
    await setSetting("engine", before.engine);
  }
});
