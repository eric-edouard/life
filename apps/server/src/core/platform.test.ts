import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LIFE_CODE_DIR, OWNER_DATA_DIR } from "./paths";
import { APP_FOLDERS, CODEX, isOwnLife, systemZone } from "./platform";

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
