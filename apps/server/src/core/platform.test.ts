import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths";
import { CODEX, systemZone } from "./platform";

test("this system's pinned codex is installed where Life runs it", () => {
  expect(existsSync(join(ROOT, CODEX))).toBe(true);
});

test("the system's time zone is one Intl knows", () => {
  const zone = systemZone() ?? "";
  expect(() => new Intl.DateTimeFormat("en", { timeZone: zone })).not.toThrow();
});
