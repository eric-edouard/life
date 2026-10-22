import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { frozenAt } from "./clock";

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
  const root = join(import.meta.dir, "..");
  const code = [...new Bun.Glob("{src,scripts}/**/*.ts").scanSync(root)]
    .map((f) => f.split(sep).join("/"))
    .filter((f) => !(f.endsWith(".test.ts") || f === "src/clock.ts"));
  const texts = await Promise.all(
    code.map((f) => Bun.file(join(root, f)).text())
  );
  expect(code.filter((_, i) => RAW_NOW.test(texts[i] ?? ""))).toEqual([]);
});
