import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hold, holder, isOtherLife, take } from "./lock";
import { STATE } from "./truth";

const lock = join(STATE, "archive.lock");

test("one archiver per Mac: a live holder keeps the lock, a dead one's is taken over", async () => {
  mkdirSync(STATE, { recursive: true });
  try {
    // Another install's archiver, alive (this test's parent process), on its own state root.
    writeFileSync(lock, `${process.ppid}\n/elsewhere/state`);
    expect(holder("archive")).toMatchObject({ note: "/elsewhere/state" });
    expect(take(lock, STATE)).toBe(false);
    // It crashed: its pid is gone, so the next start takes the lock with its own state root.
    writeFileSync(lock, "999999\n/elsewhere/state");
    expect(holder("archive")).toBeNull();
    await hold("archive");
    expect(holder("archive")).toMatchObject({
      note: STATE,
      pid: String(process.pid),
    });
  } finally {
    rmSync(lock, { force: true });
  }
});

test("another Life is a live holder on another state root, compared as real paths", () => {
  expect(isOtherLife(null)).toBe(false);
  expect(isOtherLife({ note: STATE })).toBe(false);
  expect(isOtherLife({ note: `${STATE}/` })).toBe(false);
  expect(isOtherLife({ note: "/elsewhere/state" })).toBe(true);
});
