import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { take } from "../core/lock";
import { LIFE_STATE_DIR } from "../core/paths";
import { isAppState } from "../core/platform";
import { Settings, writeSettings } from "../core/settings";

// The settings step of this release (AGENTS.md, "A rename or a new field backfills"): the `agents` setting went with
// "hey <agent>" (spoken asks, PR 3; Direction's OK of 21 Nov 2026): every "hey Life" goes through the desk. Delete it
// once it has run on his install.

/** The settings without `agents`; a file without it comes back as it is. Never through the strict parser: the old key would throw. */
export function settingsOf(old: Record<string, unknown>) {
  if (!("agents" in old)) {
    return old;
  }
  const { agents: _, ...rest } = old;
  return rest;
}

/**
 * Rewrites the settings file in `state` when it holds `agents`: on every start, before any command reads the settings
 * (`cli.ts`). The app starts several helpers at once: the rewrite holds a lock beside the file and reads it again
 * inside, so a helper never writes back a copy another changed since.
 */
export function migrateSettings(state = LIFE_STATE_DIR) {
  const path = join(state, "settings.json");
  if (
    !(existsSync(path) && readFileSync(path, "utf8").includes('"agents"')) ||
    isAppState(state)
  ) {
    return;
  }
  const lock = `${path}.migrate.lock`;
  for (let i = 0; !take(lock); i += 1) {
    if (i >= 100) {
      throw new Error(`settings step: ${lock} held for 10 s`);
    }
    Bun.sleepSync(100);
  }
  try {
    const old = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    const next = settingsOf(old);
    if (next !== old) {
      Settings.parse(next);
      writeSettings(path, next);
    }
  } finally {
    rmSync(lock, { force: true });
  }
}
