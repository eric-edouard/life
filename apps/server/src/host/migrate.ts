import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LIFE_CODE_DIR,
  LIFE_STATE_DIR,
  OWNER_DATA_DIR,
  real,
} from "../core/paths";
import { MACHINE_DIR } from "../core/platform";
import { Settings, writeSettings } from "../core/settings";

// The settings step of this release (AGENTS.md, "A rename or a new field backfills"): `histories` and `exchangeReads`
// became the personal add-ons (`core/add-ons.ts`). Delete it once it has run on his install.

type Row = Record<string, unknown>;

/** Is the app's own state, which a checkout never rewrites (the old app may still be running and would reject the new keys)? */
const isAppState = (state: string) =>
  existsSync(join(LIFE_CODE_DIR, ".git")) &&
  real(state) === real(join(MACHINE_DIR, "state"));

/**
 * The settings of an install in the old shape, in the new: `histories` under `personal`, `exchangeReads` as
 * `personal.relationshipReads` and `mentionsRead`. Personas, Between us and his views and health ran with no switch
 * before, so an install with personas stored and no `personal` yet keeps them on. Never through the strict parser: the
 * old keys would throw. A file already in the new shape comes back as it is.
 */
export function settingsOf(old: Row, hasPersonas: boolean): Row {
  const { exchangeReads, histories, ...rest } = old;
  const personal = rest.personal as Row | undefined;
  if (histories && personal?.histories) {
    throw new Error(
      "settings hold `histories` twice: one name each, never merged"
    );
  }
  const moved: Row = {
    ...(histories ? { histories } : {}),
    ...(exchangeReads === true ? { relationshipReads: {} } : {}),
  };
  const backfilled: Row =
    !personal && hasPersonas
      ? { aboutMe: {}, personas: {}, relationships: {} }
      : {};
  if (Object.keys(moved).length + Object.keys(backfilled).length === 0) {
    return old;
  }
  return {
    ...rest,
    ...(exchangeReads === true ? { mentionsRead: true } : {}),
    personal: { ...backfilled, ...personal, ...moved },
  };
}

/** Rewrites the settings file in `state` when it is in the old shape: on every start, by content, before any command reads the settings (`cli.ts`). */
export function migrateSettings(state = LIFE_STATE_DIR, dir = OWNER_DATA_DIR) {
  const path = join(state, "settings.json");
  if (!existsSync(path) || isAppState(state)) {
    return;
  }
  const old = JSON.parse(readFileSync(path, "utf8")) as Row;
  const personas = join(dir, "memory", "personas");
  const next = settingsOf(
    old,
    existsSync(personas) && readdirSync(personas).length > 0
  );
  if (next !== old) {
    Settings.parse(next);
    writeSettings(path, next);
  }
}
