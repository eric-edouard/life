import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { frozenAt } from "./clock";

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
