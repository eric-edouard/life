import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { LIFE_CODE_DIR, OWNER_DATA_DIR } from "./paths";
import {
  APP_FOLDERS,
  CODEX,
  isOwnLife,
  pathInside,
  systemZone,
} from "./platform";

test("this system's pinned codex is installed where Life runs it", () => {
  expect(existsSync(join(LIFE_CODE_DIR, CODEX))).toBe(true);
});

test("the system's time zone is one Intl knows", () => {
  const zone = systemZone() ?? "";
  expect(() => new Intl.DateTimeFormat("en", { timeZone: zone })).not.toThrow();
});

test("his own Life is the app's data folder (any install) or ~/Life; any other folder is a second Life", () => {
  expect(isOwnLife(APP_FOLDERS.data)).toBe(true);
  expect(isOwnLife(join(homedir(), "Life"))).toBe(true);
  expect(isOwnLife(OWNER_DATA_DIR)).toBe(false);
});

test("a path is inside a folder only below it: never above it, nor on another Windows drive", () => {
  expect(pathInside("/state", "/state/desk/notes.md", posix)).toBe(
    "desk/notes.md"
  );
  expect(pathInside("/state", "/state", posix)).toBe("");
  expect(pathInside("/state", "/agents/notes.md", posix)).toBeNull();
  expect(pathInside("/state", "/", posix)).toBeNull();
  // A child whose name starts with two dots is a child.
  expect(pathInside("/state", "/state/..agents/notes.md", posix)).toBe(
    "..agents/notes.md"
  );
  expect(pathInside("C:\\state", "C:\\state\\notes.md", win32)).toBe(
    "notes.md"
  );
  expect(pathInside("C:\\state", "C:\\state\\..agents", win32)).toBe(
    "..agents"
  );
  expect(pathInside("C:\\state", "C:\\agents\\notes.md", win32)).toBeNull();
  expect(pathInside("C:\\state", "D:\\agents\\notes.md", win32)).toBeNull();
});
