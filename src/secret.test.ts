import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { SECRETS, same, secretIn } from "./secret";

const KEY = /^[0-9a-f]{64}$/;

test("an empty secret never matches, not even an empty answer; a different length or byte never does", () => {
  expect(same("", "")).toBe(false);
  expect(same("abc", "abc")).toBe(true);
  expect(same("abd", "abc")).toBe(false);
  // As many characters, more bytes: false, never a RangeError.
  expect(same("éé", "ab")).toBe(false);
});

test("a key file is made whole once; an empty or broken one is replaced, never used", () => {
  const path = SECRETS.localKey;
  // The test run's own key, put back after: other tests read it.
  const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  try {
    const key = secretIn("localKey");
    expect(key).toMatch(KEY);
    expect(secretIn("localKey")).toBe(key);
    writeFileSync(path, "");
    const fresh = secretIn("localKey");
    expect(fresh).toMatch(KEY);
    expect(readFileSync(path, "utf8")).toBe(fresh);
  } finally {
    if (before === undefined) {
      rmSync(path, { force: true });
    } else {
      writeFileSync(path, before);
    }
  }
});
