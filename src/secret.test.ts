import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { same, secretIn } from "./secret";

const KEY = /^[0-9a-f]{64}$/;

test("an empty secret never matches, not even an empty answer; a different length or byte never does", () => {
  expect(same("", "")).toBe(false);
  expect(same("abc", "abc")).toBe(true);
  expect(same("abd", "abc")).toBe(false);
  // As many characters, more bytes: false, never a RangeError.
  expect(same("éé", "ab")).toBe(false);
});

test("a key file is made whole once; an empty or broken one is replaced, never used", () => {
  const path = join(mkdtempSync(join(tmpdir(), "life-secret-")), "local.key");
  const key = secretIn(path);
  expect(key).toMatch(KEY);
  expect(secretIn(path)).toBe(key);
  writeFileSync(path, "");
  const fresh = secretIn(path);
  expect(fresh).toMatch(KEY);
  expect(readFileSync(path, "utf8")).toBe(fresh);
});
