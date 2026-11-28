import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { MIN, minutes } from "./clock";
import { LIFE_CODE_DIR } from "./paths";
import { repoFiles } from "./proc";

const RAW_NOW = /new Date\(\)|Date\.now\(\)/;

test("no code reads now but through clock()", async () => {
  const code = repoFiles(
    LIFE_CODE_DIR,
    ["apps/server/src", "scripts"],
    [".ts"]
  ).filter(
    (f) => !(f.endsWith(".test.ts") || f === "apps/server/src/core/clock.ts")
  );
  const texts = await Promise.all(
    code.map((f) => Bun.file(join(LIFE_CODE_DIR, f)).text())
  );
  expect(code.filter((_, i) => RAW_NOW.test(texts[i] ?? ""))).toEqual([]);
}, 20_000); // every source file read: seconds on Windows, where a first open is slow

test("minutes rounds durations and omits an empty hour remainder", () => {
  expect([0, 0.5, 12, 59.5, 60, 98].map((m) => minutes(m * MIN))).toEqual([
    "0 min",
    "1 min",
    "12 min",
    "1 h",
    "1 h",
    "1 h 38 min",
  ]);
});

test("LIFE_NOW freezes a second Life's clock and is refused on his own data", () => {
  const run = (env: Record<string, string>) =>
    Bun.spawnSync(
      [
        "bun",
        "-e",
        'require("./platform"); console.log(require("./clock").clock().toISOString())',
      ],
      // Out of test mode, where the data folder is always a test copy.
      { cwd: import.meta.dir, env: { ...process.env, NODE_ENV: "", ...env } }
    );
  const at = "2026-03-01T09:30:00.000Z";
  const copy = run({ LIFE_NOW: at, LIFE_OWNER_DATA_DIR: "/tmp/a-copy" });
  expect(copy.stdout.toString().trim()).toBe(at);
  const own = run({
    LIFE_NOW: at,
    LIFE_OWNER_DATA_DIR: join(homedir(), "Life"),
  });
  expect(own.exitCode).not.toBe(0);
  expect(own.stderr.toString()).toContain("never his own data");
});
