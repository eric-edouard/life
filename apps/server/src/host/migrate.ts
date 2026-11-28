import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { clock } from "../core/clock";
import { linesOf, writeWhole } from "../core/files";
import { take } from "../core/lock";
import { log, logFileOf } from "../core/log";
import { LIFE_CODE_DIR, LIFE_STATE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { isAppState, isOwnLife } from "../core/platform";
import { Settings, writeSettings } from "../core/settings";
import { commitMemory } from "../memory/memory-files";
import { LOCK } from "../memory/memory-lock";
import { dayStart } from "../memory/zones";

// This release's steps (.claude/rules/memory.md, "A rename or a new field backfills"), run on every start before any command reads
// the settings or the corrections (`cli.ts`): the settings lose `agents` (spoken asks PR 3, Direction's OK of 21 Nov
// 2026) and `notifications` (Life's own checks stop pushing, his yes of 25 Nov 2026, question 18); his Not now on a your
// move card (`your-move-not-now`) becomes his Later on any check (`deferred`, question 12); the voice source's stored
// name `lifelog` becomes `voice` (his "Yes, rewrite it" of 28 Nov 2026, below). Delete each once it has run on his
// install.

/** The settings' keys this release drops. */
const GONE = ["agents", "notifications"];

/** The voice source's old stored name and its new one. */
const OLD_VOICE = "lifelog";
const VOICE = "voice";
const renamed = (v: unknown) => (v === OLD_VOICE ? VOICE : v);

/** `f` over a list: the list itself when nothing changed, so an untouched row stays the same object. */
const each =
  (f: (v: unknown) => unknown) =>
  (v: unknown): unknown => {
    if (!Array.isArray(v)) {
      return v;
    }
    const out = v.map(f);
    return out.every((x, i) => x === v[i]) ? v : out;
  };

/**
 * The settings without the keys that went, the voice source by its new name in `sources`; a file with none of them
 * comes back as it is. Never through the strict parser: an old key would throw.
 */
export function settingsOf(old: Record<string, unknown>) {
  const sources = each(renamed)(old.sources);
  if (!GONE.some((k) => k in old) && sources === old.sources) {
    return old;
  }
  return Object.fromEntries(
    Object.entries({ ...old, ...(sources ? { sources } : {}) }).filter(
      ([k]) => !GONE.includes(k)
    )
  );
}

const readJsonObject = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

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
  if (!existsSync(path) || isAppState(state)) {
    return;
  }
  const seen = readJsonObject(path);
  if (settingsOf(seen) === seen) {
    return;
  }
  const lock = `${path}.migrate.lock`;
  waitFor(lock, "settings step");
  try {
    const old = readJsonObject(path);
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
 * his Later on that matter (`move:<matter>`, held whole as Not now was: `laterUntilOf`) until the start of that day where he is. Any
 * other line comes back byte for byte. Pure but for his zone.
 */
export function correctionLineOf(line: string) {
  if (!line.includes(OLD_KIND)) {
    return line;
  }
  const {
    matter,
    steps: _steps,
    until,
    ...rest
  } = JSON.parse(line) as {
    matter?: string;
    steps: string[];
    until: string;
  };
  return JSON.stringify({
    ...rest,
    kind: "deferred",
    ref: `move:${matter ?? ""}`,
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
      'his corrections hold `your-move-not-now`: only the new Life.app moves them (.claude/rules/memory.md, "A rename or a new field backfills")'
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

// The voice source's stored name (life#709, his "Yes, rewrite it" of 28 Nov 2026): `lifelog` becomes `voice` in the
// typed fields that hold a source's name, and as the `<source>|` prefix of the message keys; never in text (quotes,
// titles, a check as shown), nor the project `lifelog` (only he renames it). Every file line for line (same count,
// same order), each line a pure function of itself that leaves a line already new byte for byte, so a rerun changes
// nothing. A voice unit's id keeps its recipe (`VOICE_UNIT_SALT`): no id changes.

const VOICE_STEP = "voice-source-2026-12";
const DONE = join("memory", "migrations.jsonl");

type Row = Record<string, unknown>;
const rekeyed = (v: unknown) =>
  typeof v === "string" && v.startsWith(`${OLD_VOICE}|`)
    ? `${VOICE}${v.slice(OLD_VOICE.length)}`
    : v;
/** `row` with `key` through `f`: the row itself when that changes nothing. */
const withField = (row: Row, key: string, f: (v: unknown) => unknown) => {
  const v = f(row[key]);
  return v === row[key] ? row : { ...row, [key]: v };
};
const isRow = (v: unknown): v is Row =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Each memory file (or folder of them) and the typed fields holding a source's name in its lines (docs/SCHEMA.md). */
const VOICE_RULES: [string, (r: Row) => Row][] = [
  ["units", (r) => withField(r, "source", renamed)],
  [
    "observations",
    (r) =>
      withField(r, "source", (v) =>
        isRow(v) ? withField(v, "channel", renamed) : v
      ),
  ],
  ["fact-checks.jsonl", (r) => withField(r, "source", renamed)],
  ["publications.jsonl", (r) => withField(r, "sources", each(renamed))],
  ["read-replies", (r) => withField(r, "messages", each(rekeyed))],
  ["appointment-events.jsonl", (r) => withField(r, "messages", each(rekeyed))],
  ["corrections.jsonl", (r) => withField(r, "inConversation", rekeyed)],
];

/** One line of `file` (a name of `VOICE_RULES`) with its source names new; any other line comes back byte for byte. */
function voiceSourceLineOf(file: string, line: string) {
  const rule = VOICE_RULES.find(([f]) => f === file)?.[1];
  const row = rule && line.includes(OLD_VOICE) ? rowOf(line) : null;
  const out = row && rule ? rule(row) : row;
  return out === row ? line : JSON.stringify(out);
}

/** A line's row; null for a line that does not parse (a torn last line), which then stays as it is. */
function rowOf(line: string) {
  try {
    const row: unknown = JSON.parse(line);
    return isRow(row) ? row : null;
  } catch {
    return null;
  }
}

/** A logged line's `reads` (what a model call read, by source) with the voice source's count under its new name; a line that does not parse stays. */
export function voiceLogLineOf(line: string) {
  const row = line.includes(`"${OLD_VOICE}":`) ? rowOf(line) : null;
  const reads = row?.reads;
  if (!(row && isRow(reads) && OLD_VOICE in reads)) {
    return line;
  }
  const { [OLD_VOICE]: n, ...rest } = reads;
  return JSON.stringify({ ...row, reads: { ...rest, [VOICE]: n } });
}

/** `path` rewritten whole through `lineOf`, only when a line changed; how many lines changed. */
function rewriteLines(path: string, lineOf: (l: string) => string) {
  const lines = readFileSync(path, "utf8").split("\n");
  const next = lines.map(lineOf);
  const changed = next.filter((l, i) => l !== lines[i]).length;
  if (changed > 0) {
    writeWhole(path, next.join("\n"));
  }
  return changed;
}

const jsonlIn = (folder: string) =>
  existsSync(folder)
    ? readdirSync(folder)
        .filter((n) => n.endsWith(".jsonl"))
        .sort()
        .map((n) => join(folder, n))
    : [];
const pathsOf = (dir: string, file: string) =>
  file.endsWith(".jsonl")
    ? [join(dir, "memory", file)].filter((p) => existsSync(p))
    : jsonlIn(join(dir, "memory", file));

const isVoiceDone = (dir: string) =>
  linesOf(join(dir, DONE)).some(
    (l) => l && (JSON.parse(l) as { name: string }).name === VOICE_STEP
  );

/**
 * Renames the voice source in `dir`'s memory once, holding memory's lock, committed in his data repo before and after,
 * then the past days' logs in `state` (today's is being appended to: its old lines only miscount a day's reads). Only
 * the app does it on his own data: a checkout stops. Returns the lines changed per file.
 */
export function migrateVoiceSource(
  dir = OWNER_DATA_DIR,
  state = LIFE_STATE_DIR
) {
  if (!existsSync(join(dir, "memory")) || isVoiceDone(dir)) {
    return null;
  }
  if (existsSync(join(LIFE_CODE_DIR, ".git")) && isOwnLife(dir)) {
    throw new Error(
      'his memory still names the voice source `lifelog`: only the new Life.app renames it (AGENTS.md, "A rename or a new field backfills")'
    );
  }
  const isRepo = existsSync(join(dir, ".git"));
  const counts: Partial<Record<string, number>> = {};
  waitFor(LOCK, "voice source step");
  try {
    if (isVoiceDone(dir)) {
      return null;
    }
    if (isRepo) {
      commitMemory(["memory"], "Memory: before the voice source's rename");
    }
    for (const [file] of VOICE_RULES) {
      for (const path of pathsOf(dir, file)) {
        counts[file] =
          (counts[file] ?? 0) +
          rewriteLines(path, (l) => voiceSourceLineOf(file, l));
      }
    }
    appendFileSync(
      join(dir, DONE),
      `${JSON.stringify({ at: clock().toISOString(), name: VOICE_STEP, schemaVersion: 1 })}\n`
    );
    if (isRepo) {
      commitMemory(
        ["memory"],
        `Memory: the voice source renamed (${VOICE_STEP})`
      );
    }
  } finally {
    rmSync(LOCK, { force: true });
  }
  if (!isAppState(state)) {
    const today = logFileOf(clock().toISOString());
    for (const path of jsonlIn(join(state, "log")).filter(
      (p) => !p.endsWith(today)
    )) {
      counts.log = (counts.log ?? 0) + rewriteLines(path, voiceLogLineOf);
    }
  }
  return counts;
}

/** Every step of this release, on every start (`cli.ts`), before any command reads the settings or his memory. */
export function migrateSettings(state = LIFE_STATE_DIR, dir = OWNER_DATA_DIR) {
  migrateSettingsFile(state);
  migrateCorrections(dir);
  const counts = migrateVoiceSource(dir, state);
  if (counts) {
    log("run.end", { counts, step: `memory.migrate.${VOICE_STEP}` });
  }
}
