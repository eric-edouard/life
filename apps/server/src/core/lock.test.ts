import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hold, holder, isOtherLife, oneAtATimeAcross, take } from "./lock";
import { LIFE_STATE_DIR } from "./paths";
import { MACHINE_DIR } from "./platform";

const lock = join(MACHINE_DIR, "archive.lock");

test("one archiver per Mac: a live holder keeps the lock, a dead one's is taken over", async () => {
  mkdirSync(MACHINE_DIR, { recursive: true });
  try {
    // Another install's archiver, alive (this test's process), on its own state dir.
    writeFileSync(lock, `${process.pid}\n/elsewhere/state`);
    expect(holder("archive")).toMatchObject({ note: "/elsewhere/state" });
    expect(take(lock, LIFE_STATE_DIR)).toBe(false);
    // It crashed: its pid is gone, so the next start takes the lock with its own state dir.
    writeFileSync(lock, "999999\n/elsewhere/state");
    expect(holder("archive")).toBeNull();
    await hold("archive");
    expect(holder("archive")).toMatchObject({
      note: LIFE_STATE_DIR,
      pid: String(process.pid),
    });
  } finally {
    rmSync(lock, { force: true });
  }
});

test("another Life is a live holder on another state dir, compared as real paths", () => {
  expect(isOtherLife(null)).toBe(false);
  expect(isOtherLife({ note: LIFE_STATE_DIR })).toBe(false);
  expect(isOtherLife({ note: `${LIFE_STATE_DIR}/` })).toBe(false);
  expect(isOtherLife({ note: "/elsewhere/state" })).toBe(true);
});

test("two chains on one lock file (as two processes would hold) never overlap, a failure included", async () => {
  mkdirSync(LIFE_STATE_DIR, { recursive: true });
  const path = join(LIFE_STATE_DIR, "test-chain.lock");
  const [a, b] = [oneAtATimeAcross(path, 5), oneAtATimeAcross(path, 5)];
  const seen: string[] = [];
  const step =
    (name: string, fail = false) =>
    async () => {
      seen.push(`${name} in`);
      await Bun.sleep(20);
      seen.push(`${name} out`);
      if (fail) {
        throw new Error(name);
      }
    };
  await Promise.allSettled([a(step("a1", true)), b(step("b1")), a(step("a2"))]);
  expect(
    seen.filter((_, i) => i % 2 === 0).map((s) => s.split(" ")[0])
  ).toEqual(seen.filter((_, i) => i % 2 === 1).map((s) => s.split(" ")[0]));
  expect(seen).toHaveLength(6);
  rmSync(path, { force: true });
});
