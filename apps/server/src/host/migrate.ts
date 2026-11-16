import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIFE_CODE_DIR, LIFE_STATE_DIR, real } from "../core/paths";
import { MACHINE_DIR } from "../core/platform";
import { Settings, writeSettings } from "../core/settings";

// The settings step of this release (AGENTS.md, "A rename or a new field backfills"): matters, links, endings, the
// conversation summaries and the mentions read became core, with no switch. Delete it once it has run on his install.

type Row = Record<string, unknown>;

/** The switches that left the settings: the parts they turned on are always on. */
const CORE = [
  "conversationSummaries",
  "endings",
  "links",
  "matters",
  "mentionsRead",
] as const;

/** Is the app's own state, which a checkout never rewrites (the old app may still be running)? */
const isAppState = (state: string) =>
  existsSync(join(LIFE_CODE_DIR, ".git")) &&
  real(state) === real(join(MACHINE_DIR, "state"));

/** The settings without the core switches; a file holding none comes back as it is. Never through the strict parser: the old keys would throw. */
function settingsOf(old: Row): Row {
  if (!CORE.some((key) => key in old)) {
    return old;
  }
  return Object.fromEntries(
    Object.entries(old).filter(
      ([key]) => !(CORE as readonly string[]).includes(key)
    )
  );
}

/** Rewrites the settings file in `state` when it holds a core switch: on every start, before any command reads the settings (`cli.ts`). */
export function migrateSettings(state = LIFE_STATE_DIR) {
  const path = join(state, "settings.json");
  if (!existsSync(path) || isAppState(state)) {
    return;
  }
  const old = JSON.parse(readFileSync(path, "utf8")) as Row;
  const next = settingsOf(old);
  if (next !== old) {
    Settings.parse(next);
    writeSettings(path, next);
  }
}
