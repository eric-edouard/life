import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { linesOf, writeWhole } from "../core/files";
import { take } from "../core/lock";
import { LIFE_CODE_DIR, LIFE_STATE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { isAppState, isOwnLife } from "../core/platform";
import { Settings, writeSettings } from "../core/settings";
import { commitMemory } from "../memory/memory-files";
import { LOCK } from "../memory/memory-lock";
import { dayStart } from "../memory/zones";

// This release's steps (AGENTS.md, "A rename or a new field backfills"), run on every start before any command reads
// the settings or the corrections (`cli.ts`): the settings lose `agents` (spoken asks PR 3, Direction's OK of 21 Nov
// 2026) and `notifications` (Life's own checks stop pushing, his yes of 25 Nov 2026, question 18); his Not now on a your
// move card (`your-move-not-now`) becomes his Later on any check (`deferred`, question 12). Delete each once it has run
// on his install.

/** The settings' keys this release drops. */
const GONE = ["agents", "notifications"];

/** The settings without the keys that went; a file with none of them comes back as it is. Never through the strict parser: an old key would throw. */
export function settingsOf(old: Record<string, unknown>) {
  if (!GONE.some((k) => k in old)) {
    return old;
  }
  return Object.fromEntries(
    Object.entries(old).filter(([k]) => !GONE.includes(k))
  );
}

/** Takes lock file `lock`, waiting up to 10 s: the app starts several helpers at once. */
function waitFor(lock: string, what: string) {
  for (let i = 0; !take(lock); i += 1) {
    if (i >= 100) {
      throw new Error(`${what}: ${lock} held for 10 s`);
    }
    Bun.sleepSync(100);
  }
}

/** Rewrites the settings file in `state` when it holds a key that went, under a lock beside it, reading it again inside, so a helper never writes back a copy another changed since. */
function migrateSettingsFile(state: string) {
  const path = join(state, "settings.json");
  if (
    !(
      existsSync(path) &&
      GONE.some((k) => readFileSync(path, "utf8").includes(`"${k}"`))
    ) ||
    isAppState(state)
  ) {
    return;
  }
  const lock = `${path}.migrate.lock`;
  waitFor(lock, "settings step");
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

const OLD_KIND = '"your-move-not-now"';

/**
 * One corrections line as it reads now: his Not now on a your move card (`matter`, `steps`, `until` a local day) becomes
 * his Later on that card's ref (`move:<matter>/<step>`, its newest step) until the start of that day where he is. Any
 * other line comes back byte for byte. Pure but for his zone.
 */
export function correctionLineOf(line: string) {
  if (!line.includes(OLD_KIND)) {
    return line;
  }
  const { matter, steps, until, ...rest } = JSON.parse(line) as {
    matter?: string;
    steps: string[];
    until: string;
  };
  return JSON.stringify({
    ...rest,
    kind: "deferred",
    ref: `move:${matter ?? ""}/${steps.at(-1) ?? ""}`,
    until: dayStart(until).toISOString(),
  });
}

/**
 * Rewrites `memory/corrections.jsonl` in `dir` line for line (same count, same order) when it holds a Not now, under
 * memory's lock, committed in his data repo before and after. Only the app does it on his own data: a checkout stops.
 */
function migrateCorrections(dir: string) {
  const path = join(dir, "memory", "corrections.jsonl");
  if (!(existsSync(path) && readFileSync(path, "utf8").includes(OLD_KIND))) {
    return;
  }
  if (existsSync(join(LIFE_CODE_DIR, ".git")) && isOwnLife(dir)) {
    throw new Error(
      'his corrections hold `your-move-not-now`: only the new Life.app moves them (AGENTS.md, "A rename or a new field backfills")'
    );
  }
  const isRepo = existsSync(join(dir, ".git"));
  waitFor(LOCK, "corrections step");
  try {
    const lines = linesOf(path);
    if (!lines.some((l) => l.includes(OLD_KIND))) {
      return;
    }
    if (isRepo) {
      commitMemory(["memory"], "Memory: before Later replaces Not now");
    }
    writeWhole(path, `${lines.map(correctionLineOf).join("\n")}\n`);
    if (isRepo) {
      commitMemory(["memory"], "Memory: Not now became Later (deferred)");
    }
  } finally {
    rmSync(LOCK, { force: true });
  }
}

/** Every step of this release, on every start (`cli.ts`), before any command reads the settings or his corrections. */
export function migrateSettings(state = LIFE_STATE_DIR, dir = OWNER_DATA_DIR) {
  migrateSettingsFile(state);
  migrateCorrections(dir);
}
