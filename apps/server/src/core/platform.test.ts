import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LIFE_CODE_DIR } from "./paths";
import { CODEX, MAC, systemZone, WINDOWS } from "./platform";

// A server has no Codex: its calls go to OpenRouter.
test.skipIf(!(MAC || WINDOWS))(
  "this system's pinned codex is installed where Life runs it",
  () => {
    expect(existsSync(join(LIFE_CODE_DIR, CODEX))).toBe(true);
  }
);

test.skipIf(!(MAC || WINDOWS))(
  "the system's time zone is one Intl knows",
  () => {
    const zone = systemZone() ?? "";
    expect(
      () => new Intl.DateTimeFormat("en", { timeZone: zone })
    ).not.toThrow();
  }
);
