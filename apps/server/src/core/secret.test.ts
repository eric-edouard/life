import { expect, test } from "bun:test";
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readSecretEnv, SECRETS, same, secretIn, setSecretEnv } from "./secret";

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

test("a server's keys: set some, keep the rest, null removes one; a bad name or a second line is refused", () => {
  setSecretEnv({ MADE_UP_KEY: "a=b", OTHER_KEY: "x" });
  setSecretEnv({ OTHER_KEY: null, THIRD_KEY: "y" });
  expect(readSecretEnv()).toEqual({ MADE_UP_KEY: "a=b", THIRD_KEY: "y" });
  expect((statSync(SECRETS.env).mode % 0o1000).toString(8)).toBe("600");
  expect(() => setSecretEnv({ "bad name": "x" })).toThrow("bad name");
  expect(() => setSecretEnv({ MADE_UP_KEY: "x\nEVIL=1" })).toThrow();
  expect(readSecretEnv()).toEqual({ MADE_UP_KEY: "a=b", THIRD_KEY: "y" });
});
