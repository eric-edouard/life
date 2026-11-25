import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayStart } from "../memory/zones";
import { Correction } from "../records/observation";
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

test("a helper starting after the step leaves a later change of the settings as it is", () => {
  const state = mkdtempSync(join(tmpdir(), "life-migrate-"));
  const path = join(state, "settings.json");
  writeFileSync(
    path,
    JSON.stringify({ agents: {}, memoryLanguage: "English" })
  );
  migrateSettings(state);
  writeFileSync(path, JSON.stringify({ memoryLanguage: "French" }));
  migrateSettings(state);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    memoryLanguage: "French",
  });
  expect(existsSync(`${path}.migrate.lock`)).toBe(false);
});

test("the settings step drops `notifications` too", () => {
  expect(settingsOf({ notifications: {}, sources: ["git"] })).toEqual({
    sources: ["git"],
  });
});

test("the corrections step: a Not now becomes Later on its card's ref, line for line; every other line stays byte for byte", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-migrate-data-"));
  mkdirSync(join(dir, "memory"));
  const path = join(dir, "memory", "corrections.jsonl");
  const other =
    '{"at":"2026-11-15T09:00:00.000Z","kind":"wrong","observations":["obs_000000000001"],"schemaVersion":1}';
  const notNow = JSON.stringify({
    at: "2026-11-15T09:00:00.000Z",
    kind: "your-move-not-now",
    matter: "matter_000000000007",
    schemaVersion: 1,
    steps: ["obs_000000000002", "obs_000000000003"],
    until: "2026-11-18",
  });
  writeFileSync(path, `${other}\n${notNow}\n${other}\n`);
  migrateSettings(mkdtempSync(join(tmpdir(), "life-migrate-")), dir);
  const lines = readFileSync(path, "utf8").split("\n");
  expect(lines).toHaveLength(4);
  expect(lines[0]).toBe(other);
  expect(lines[2]).toBe(other);
  const moved = Correction.parse(JSON.parse(lines[1] ?? ""));
  expect(moved).toMatchObject({
    kind: "deferred",
    ref: "move:matter_000000000007",
  });
  expect(Date.parse((moved as { until: string }).until)).toBe(
    dayStart("2026-11-18").getTime()
  );
  // Run again, nothing changes.
  const before = readFileSync(path, "utf8");
  migrateSettings(mkdtempSync(join(tmpdir(), "life-migrate-")), dir);
  expect(readFileSync(path, "utf8")).toBe(before);
});
