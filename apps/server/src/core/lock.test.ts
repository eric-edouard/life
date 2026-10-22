import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hold, holder, isOtherLife, take } from "./lock";
import { LIFE_STATE_DIR } from "./paths";
import { MACHINE_DIR } from "./platform";

const lock = join(MACHINE_DIR, "archive.lock");

test("one archiver per Mac: a live holder keeps the lock, a dead one's is taken over", async () => {
  mkdirSync(MACHINE_DIR, { recursive: true });
  try {
    // Another install's archiver, alive (this test's parent process), on its own state dir.
    writeFileSync(lock, `${process.ppid}\n/elsewhere/state`);
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
