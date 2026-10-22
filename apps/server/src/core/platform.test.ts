import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ARCHIVE } from "../sources/archived";
import { BEEPER } from "../sources/beeper";
import { DB } from "../sources/imessage";
import { NOTES } from "../sources/notes";
import { WHATSAPP } from "../sources/whatsapp";
import { ROOT, STATE } from "./paths";
import { APP_DATA, CODEX, HOME, MACHINE, systemZone } from "./platform";
import { expand } from "./settings";

test("this system's pinned codex is installed where Life runs it", () => {
  expect(existsSync(join(ROOT, CODEX))).toBe(true);
});

test("the system's time zone is one Intl knows", () => {
  const zone = systemZone() ?? "";
  expect(() => new Intl.DateTimeFormat("en", { timeZone: zone })).not.toThrow();
});

test("a test run reads nothing of this computer: every store path is under its own state", () => {
  const paths = [HOME, APP_DATA, MACHINE, ARCHIVE, DB, NOTES, WHATSAPP, BEEPER];
  for (const p of [...paths, expand("~/Work")]) {
    expect(p.startsWith(STATE)).toBe(true);
  }
});
