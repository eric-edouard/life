import { expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hold, holder, isOtherLife, take } from "./lock";
import { LIFE_STATE_DIR } from "./paths";
import { MACHINE_DIR, startTicks } from "./platform";

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

test("a reused pid holds nothing: a container's next start finds its own pids in the last one's locks", () => {
  mkdirSync(MACHINE_DIR, { recursive: true });
  try {
    // This process's own pid, in a lock written a year before it started (or before the boot, where no start is known).
    writeFileSync(lock, `${process.pid}\n/elsewhere/state`);
    const year = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    utimesSync(lock, year, year);
    expect(holder("archive")).toBeNull();
  } finally {
    rmSync(lock, { force: true });
  }
});

test.skipIf(!startTicks(process.pid))(
  "where the system tells a start, only the same process holds its lock",
  () => {
    mkdirSync(MACHINE_DIR, { recursive: true });
    try {
      expect(take(lock, LIFE_STATE_DIR)).toBe(true);
      expect(holder("archive")).toMatchObject({ pid: String(process.pid) });
      // The same pid, started at another time: a later process's, after a container's restart.
      writeFileSync(lock, `${process.pid}\n${LIFE_STATE_DIR}\n1`);
      expect(holder("archive")).toBeNull();
    } finally {
      rmSync(lock, { force: true });
    }
  }
);

test("another Life is a live holder on another state dir, compared as real paths", () => {
  expect(isOtherLife(null)).toBe(false);
  expect(isOtherLife({ note: LIFE_STATE_DIR })).toBe(false);
  expect(isOtherLife({ note: `${LIFE_STATE_DIR}/` })).toBe(false);
  expect(isOtherLife({ note: "/elsewhere/state" })).toBe(true);
});
