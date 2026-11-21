import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSettings, settingsOf } from "./migrate";

test("the settings step drops `agents` and keeps the rest; a file without it is left as it is", () => {
  const without = { sources: ["git"] };
  expect(settingsOf(without)).toBe(without);
  const state = mkdtempSync(join(tmpdir(), "life-migrate-"));
  const path = join(state, "settings.json");
  writeFileSync(
    path,
    JSON.stringify({ agents: { Comet: { wake: ["comet"] } }, ...without })
  );
  migrateSettings(state);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(without);
});
