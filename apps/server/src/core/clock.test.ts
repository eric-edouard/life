import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { frozenAt } from "./clock";
import { LIFE_CODE_DIR } from "./paths";
import { repoFiles } from "./proc";

const RAW_NOW = /new Date\(\)|Date\.now\(\)/;

test("LIFE_NOW freezes the clock, on a copy in a worktree only, at a valid instant", () => {
  expect(frozenAt(undefined, "/tmp/copy")).toBeUndefined();
  expect(frozenAt("2026-10-20T09:10:44Z", "/tmp/copy")).toBe(
    Date.parse("2026-10-20T09:10:44Z")
  );
  expect(() => frozenAt("yesterday", "/tmp/copy")).toThrow("ISO instant");
  expect(() =>
    frozenAt("2026-10-20T09:10:44Z", join(homedir(), "Life"))
  ).toThrow("never ~/Life");
  expect(() => frozenAt("2026-10-20T09:10:44Z", "/tmp/copy", true)).toThrow(
    "worktree of its own"
  );
});

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
