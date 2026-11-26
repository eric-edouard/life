import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// tools/heavy.sh: a lane's lock must be freed at exit, and a dead holder's lock taken over (26 Nov: a phone install
// waited 27 minutes on the lock a finished Life.app build left behind).
const run = (state: string) =>
  Bun.spawnSync(["bash", "tools/heavy.sh", "true"], {
    env: { ...process.env, LIFE_TOOLS_STATE: state, HEAVY_LANE: "release" },
    timeout: 15_000,
  }).exitCode;

test("a lane runs twice in a row", () => {
  const state = mkdtempSync(join(tmpdir(), "heavy-"));
  expect(run(state)).toBe(0);
  expect(run(state)).toBe(0);
});

test("a dead holder's lane lock is taken over", () => {
  const state = mkdtempSync(join(tmpdir(), "heavy-"));
  mkdirSync(join(state, "check.lock.release"));
  writeFileSync(join(state, "check.lock.release", "pid"), "999999\n");
  expect(run(state)).toBe(0);
});
