import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// tools/heavy.sh: a lane's lock must be freed at exit, and a dead holder's lock taken over (26 Nov: a phone install
// waited 27 minutes on the lock a finished Life.app build left behind).
const run = (state: string) =>
  Bun.spawnSync(["bash", "tools/heavy.sh", "true"], {
    env: { ...process.env, HEAVY_LANE: "release", LIFE_TOOLS_STATE: state },
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

test("a job inside a held slot runs at once, even on its own lane's lock", () => {
  const state = mkdtempSync(join(tmpdir(), "heavy-"));
  mkdirSync(join(state, "check.lock.release"));
  writeFileSync(join(state, "check.lock.release", "pid"), `${process.pid}\n`);
  const out = Bun.spawnSync(["bash", "tools/heavy.sh", "true"], {
    env: {
      ...process.env,
      HEAVY_HELD: "1",
      HEAVY_LANE: "release",
      LIFE_TOOLS_STATE: state,
    },
    timeout: 15_000,
  });
  expect(out.exitCode).toBe(0);
});

// .githooks/pre-push takes a heavy slot for the check, except a push already inside one (26 Nov: a builder's plain push
// ran the full check beside other heavy jobs). The check is a stub `bun` that prints what it ran under.
const push = (extra: Record<string, string>) => {
  const state = mkdtempSync(join(tmpdir(), "heavy-"));
  const bin = join(state, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "bun"),
    '#!/bin/sh\necho "held=$HEAVY_HELD swift=$LIFE_CHECK_SWIFT"\n',
    { mode: 0o755 }
  );
  const out = Bun.spawnSync(["sh", ".githooks/pre-push"], {
    env: {
      ...process.env,
      HEAVY_HELD: "",
      HEAVY_LANE: "",
      LIFE_CHECK_SWIFT: "",
      LIFE_TOOLS_STATE: state,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: state,
      ...extra,
    },
    timeout: 15_000,
  });
  return { out: out.stdout.toString().trim(), state };
};

test("a push inside a heavy slot runs its check at once, even with every slot held", () => {
  const state = mkdtempSync(join(tmpdir(), "heavy-"));
  for (const lock of ["check.lock", "check.lock.2", "check.lock.land"]) {
    mkdirSync(join(state, lock));
    writeFileSync(join(state, lock, "pid"), `${process.pid}\n`);
  }
  expect(push({ HEAVY_HELD: "1", LIFE_TOOLS_STATE: state }).out).toBe(
    "held=1 swift="
  );
});

test("a landing push takes the land lane, which runs the Swift builds", () => {
  const branch = Bun.spawnSync(["git", "branch", "--show-current"])
    .stdout.toString()
    .trim();
  const state = mkdtempSync(join(tmpdir(), "heavy-"));
  mkdirSync(join(state, "work-on-code-land-1"));
  writeFileSync(join(state, "work-on-code-land-1", "branch"), `${branch}\n`);
  expect(push({ TMPDIR: state }).out).toBe("held=1 swift=");
});
