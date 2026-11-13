import { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { clock } from "../core/clock";
import { linesOf } from "../core/files";
import { holder } from "../core/lock";
import { log, logFileOf } from "../core/log";
import {
  isHis,
  LIFE_CODE_DIR,
  LIFE_STATE_DIR,
  OWNER_DATA_DIR,
  real,
} from "../core/paths";
import { MACHINE_DIR } from "../core/platform";
import { reindex } from "../memory/index-writer";
import { commitMemory } from "../memory/memory-files";
import { locked } from "../memory/memory-lock";
import { rebuildPassages } from "../memory/passage-rebuild";
import { tables } from "../memory/sources";
import { unitId } from "../memory/units";
import { dayNow, localDate } from "../memory/zones";

// A rename backfills (AGENTS.md): the names' pass (14 Nov 2026, his OK on the list, PLAN S1–S27). This file is the one
// place that knows both names: every stored line is rewritten in place (same count, same order, so the
// `read_memory_changes` cursor holds), each a pure function of one line that leaves a line already new as it is. What
// he told Life becomes the source `told-life`: its units' ids change by a map taken from the units' days (never their
// content), so a start after a crash finds the same map. The episode role `told` stays. The settings and today's log
// are renamed on every start; the rest once, by the app, under the lock, committed in his data repo before and after.
// It goes once it ran on his data.

const STEP = "names-2026-11";
const DONE = "memory/migrations.jsonl";
/** What the commits before and after hold: the judge cases (S22) are outside memory/. */
const COMMITTED = ["memory", "docs/evals"];
/** Files renamed whole (S1, S2, S14), old → new. */
const RENAMED = [
  ["memory/statements.jsonl", "memory/fact-checks.jsonl"],
  ["memory/ratings.jsonl", "memory/fact-check-answers.jsonl"],
  ["memory/told.jsonl", "memory/told-life.jsonl"],
] as const;
/** The settings' keys (S24), old → new. */
const SETTINGS_KEYS = [
  ["past", "pastCalendar"],
  ["appointments", "appointmentsCalendar"],
  ["reports", "agentReportSenders"],
  ["devices", "deviceNames"],
  ["repos", "reposFolder"],
  ["history", "histories"],
  ["todo_list", "todoList"],
] as const;
const OLD_TOLD = "told";
const TOLD_LIFE = "told-life";
const PAGE_SECTIONS: Record<string, string> = {
  bond: "between_us",
  history: "earlier",
};
const LOG_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const JUDGE_CASES = /^judge-cases-.*\.json$/;

interface Row {
  [key: string]: unknown;
}
type Rule = (r: Row) => Row;
type Value = (v: unknown) => unknown;

// Each rule returns its row itself when it changes nothing, so an untouched line is kept byte for byte.
const set = (r: Row, key: string, v: unknown): Row =>
  r[key] === v ? r : { ...r, [key]: v };
/** `from` renamed `to`, the keys in the order the records' schemas write them (the formatter's, sorted). */
const rename =
  (from: string, to: string): Rule =>
  (r) =>
    from in r
      ? Object.fromEntries(
          Object.entries(r)
            .map(([k, v]): [string, unknown] => [k === from ? to : k, v])
            .toSorted(([a], [b]) => (a < b ? -1 : 1))
        )
      : r;
const field =
  (key: string, f: Value): Rule =>
  (r) =>
    key in r ? set(r, key, f(r[key])) : r;
const when =
  (key: string, is: unknown, rule: Rule): Rule =>
  (r) =>
    r[key] === is ? rule(r) : r;
const all =
  (...rules: Rule[]): Rule =>
  (r) =>
    rules.reduce((x, f) => f(x), r);
const value =
  (from: unknown, to: unknown): Value =>
  (v) =>
    v === from ? to : v;
const each =
  (f: Value): Value =>
  (v) => {
    if (!Array.isArray(v)) {
      return v;
    }
    const out = v.map(f);
    return out.every((x, i) => x === v[i]) ? v : out;
  };
const inRow =
  (rule: Rule): Value =>
  (v) =>
    v && typeof v === "object" && !Array.isArray(v) ? rule(v as Row) : v;
const told = value(OLD_TOLD, TOLD_LIFE);
const toldRef: Value = (v) =>
  typeof v === "string" && v.startsWith(`${OLD_TOLD}:`)
    ? `${TOLD_LIFE}${v.slice(OLD_TOLD.length)}`
    : v;
const prompt = (from: string, to: string) =>
  field("madeBy", inRow(field("prompt", value(from, to))));
const runEntered = when(
  "kind",
  "run.phase",
  all(
    field("kind", value("run.phase", "run.entered")),
    rename("phase", "entered")
  )
);

/** The told units' ids, old → new, for every day memory has units of: from the days alone, so a rerun finds it again. */
const toldIdsOf = (dir: string) =>
  new Map(
    jsonlIn(dir, "memory/units").map((path) => {
      const day = path.slice(-"YYYY-MM-DD.jsonl".length, -".jsonl".length);
      return [
        unitId(OLD_TOLD, OLD_TOLD, day),
        unitId(TOLD_LIFE, TOLD_LIFE, day),
      ];
    })
  );

/** Each memory file (or folder of them) and its rule, the files citing told units before the units themselves (S15). */
const rulesOf = (ids: Map<string, string>): [string, Rule][] => {
  const unit: Value = (v) => (typeof v === "string" && ids.get(v)) || v;
  const units = field("units", each(unit));
  return [
    ["memory/verdicts.jsonl", field("unit", unit)],
    ["memory/extracted.jsonl", field("unit", unit)],
    [
      "memory/unresolved.jsonl",
      all(rename("surface", "nameAsWritten"), field("unit", unit)),
    ],
    [
      "memory/observations",
      all(
        rename("entities", "subjects"),
        field("unit", unit),
        field(
          "source",
          inRow(
            when(
              "channel",
              OLD_TOLD,
              all(field("channel", told), field("ref", toldRef))
            )
          )
        )
      ),
    ],
    ["memory/episodes", all(units, field("copies", each(unit)))],
    [
      "memory/labels.jsonl",
      all(rename("matters", "important"), field("unitId", unit)),
    ],
    [
      "memory/corrections.jsonl",
      all(
        units,
        when(
          "kind",
          "keep-mine",
          field("section", (v) => PAGE_SECTIONS[v as string] ?? v)
        ),
        when("kind", "this-is", rename("surface", "nameOrHandle")),
        when("kind", "not-this-person", rename("surface", "nameOrHandle"))
      ),
    ],
    // Under either name: a start after a crash may find it renamed already (S1).
    ...["memory/statements.jsonl", "memory/fact-checks.jsonl"].map(
      (f): [string, Rule] => [f, all(units, field("source", told))]
    ),
    [
      "memory/people-inferred.jsonl",
      all(
        rename("surfaces", "namesAndHandles"),
        field("evidence", each(inRow(field("unit", unit))))
      ),
    ],
    ["memory/people-contacts.jsonl", rename("surfaces", "handles")],
    [
      "memory/ledger.jsonl",
      all(
        field("kind", value("grant", "auto_add")),
        field("target", value("grant", "auto_add")),
        field("after", inRow(rename("link", "deepLinkId"))),
        field("via", value("reminders", "todo_list"))
      ),
    ],
    ["memory/publications.jsonl", field("sources", each(told))],
    ["memory/read-replies", rename("wording", "promptDigest")],
    [
      "memory/files.jsonl",
      all(
        rename("what", "description"),
        prompt("files.v1", "message-file-description.v1")
      ),
    ],
    ["memory/imported.jsonl", prompt("import.v1", "import-keep.v1")],
    ["memory/repos-inferred.jsonl", prompt("repos.v1", "repo-project.v1")],
    ["memory/closeness.jsonl", prompt("closeness.v1", "memory-closeness.v1")],
    ["memory/scores.jsonl", rename("rated", "answered")],
    [
      "memory/units",
      when(
        "source",
        OLD_TOLD,
        all(
          field("id", unit),
          field("source", told),
          field("key", told),
          field("refs", each(toldRef)),
          field("marked", each(toldRef))
        )
      ),
    ],
  ];
};

/** A JSON line through `rule`: written again only when it changed. */
const jsonLine = (rule: Rule) => (l: string) => {
  if (!l) {
    return l;
  }
  const r = JSON.parse(l) as Row;
  const out = rule(r);
  return out === r ? l : JSON.stringify(out);
};
/** A log line: only `run.phase` lines are read; one that does not parse stays (a log line must never stop a reader). */
const logLine = (l: string) => {
  if (!l.includes('"kind":"run.phase"')) {
    return l;
  }
  try {
    return jsonLine(runEntered)(l);
  } catch {
    return l;
  }
};

/** Whole, so a reader never meets half of it. */
const writeWhole = (path: string, text: string) => {
  writeFileSync(`${path}.${process.pid}.tmp`, text);
  renameSync(`${path}.${process.pid}.tmp`, path);
};
/** A file rewritten line by line, only when a line changed: its line count before and after. */
function rewrite(
  path: string,
  lineOf: (l: string) => string
): [number, number] {
  if (!existsSync(path)) {
    return [0, 0];
  }
  const text = readFileSync(path, "utf8");
  const next = text.split("\n").map(lineOf).join("\n");
  if (next !== text) {
    writeWhole(path, next);
  }
  return [text.split("\n").length - 1, next.split("\n").length - 1];
}
const filesIn = (folder: string, keep: (name: string) => boolean) =>
  existsSync(folder)
    ? readdirSync(folder)
        .filter(keep)
        .sort()
        .map((n) => join(folder, n))
    : [];
const jsonlIn = (dir: string, rel: string) =>
  filesIn(join(dir, rel), (n) => n.endsWith(".jsonl"));
const pathsOf = (dir: string, rel: string) =>
  rel.endsWith(".jsonl") ? [join(dir, rel)] : jsonlIn(dir, rel);

/** A judge cases file with each case's `claims` as `memoryLines` (S22): keys only, never a grade. */
function renameJudgeCases(path: string) {
  const file = JSON.parse(readFileSync(path, "utf8")) as Row;
  const cases = each(inRow(rename("claims", "memoryLines")))(file.cases);
  if (cases !== file.cases) {
    writeWhole(path, `${JSON.stringify({ ...file, cases }, null, 2)}\n`);
  }
}

/** The photo descriptions written under the old prompt's name (S25); a row already under the new one is kept. */
function renamePhotoPrompt(path: string) {
  if (!existsSync(path)) {
    return;
  }
  const db = new Database(path);
  try {
    db.run("pragma busy_timeout = 30000");
    db.run(
      "update or ignore descriptions set prompt = 'photo-description.v1' where prompt = 'photos.v1'"
    );
  } finally {
    db.close();
  }
}

/** The kept grades of `--fact-check-answers` (S27): derived, gone when they hold the judge's old key, judged again once. */
function dropKeptGrades(path: string) {
  const kept = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, { grade: Row }>)
    : {};
  if (Object.values(kept).some((k) => "claims" in k.grade)) {
    rmSync(path);
  }
}

/** The passages of what he told Life, under the old source: their ids hold it, so they go and are written again. */
function dropToldPassages(path: string) {
  if (!existsSync(path)) {
    return;
  }
  const db = new Database(path);
  try {
    db.run("pragma busy_timeout = 30000");
    db.run("delete from passages where source = ?", [OLD_TOLD]);
    db.run("delete from coverage where source = ?", [OLD_TOLD]);
  } finally {
    db.close();
  }
}

/** The told-life passages, from the day of the first thing he told Life to today. */
async function writeToldPassages(dir: string) {
  const [first] = linesOf(join(dir, "memory/told-life.jsonl"));
  const read = tables().SEARCHED[TOLD_LIFE];
  if (!(first && read)) {
    return;
  }
  const from = localDate((JSON.parse(first) as { at: string }).at);
  const out = await rebuildPassages(
    { from, to: dayNow() },
    { sources: () => ({ [TOLD_LIFE]: read }) }
  );
  if (out.failed) {
    throw new Error(`the told-life passages: ${out.error}`);
  }
}

/** Does this code run from a repo (a checkout or a worktree) rather than from Life.app's resources? */
const runsFromRepo = () => existsSync(join(LIFE_CODE_DIR, ".git"));
/** The app's state folder: a checkout whose state links to it never renames it (the old app may still be running). */
const isAppState = (state: string) =>
  runsFromRepo() && real(state) === real(join(MACHINE_DIR, "state"));
/** Only the app migrates his own data and its state: a checkout may migrate copies, never his. */
export const mayMigrate = (dir: string, state: string) =>
  !((runsFromRepo() && isHis(dir)) || isAppState(state));

const isDone = (dir: string) =>
  linesOf(join(dir, DONE)).some((l) => l && JSON.parse(l).name === STEP);

/** The settings' old keys new (S24), and `told` in `sources`; a key under both names stops it. On every start. */
export function renameSettings(state = LIFE_STATE_DIR) {
  const path = join(state, "settings.json");
  if (!existsSync(path) || isAppState(state)) {
    return;
  }
  const old = JSON.parse(readFileSync(path, "utf8")) as Row;
  const both = SETTINGS_KEYS.filter(([o, n]) => o in old && n in old);
  if (both.length > 0) {
    throw new Error(
      `${path} holds ${both.map((b) => b.join(" and ")).join(", ")}: one name each, never merged`
    );
  }
  const next = all(
    ...SETTINGS_KEYS.map(([o, n]) => rename(o, n)),
    field("sources", each(told))
  )(old);
  if (next !== old) {
    writeWhole(path, `${JSON.stringify(next, null, 2)}\n`);
  }
}

/** Today's log, its `run.phase` lines as `run.entered` (S26): on every start, before the archive starts. */
function renameTodayLog(state: string) {
  if (!isAppState(state)) {
    rewrite(join(state, "log", logFileOf(clock().toISOString())), logLine);
  }
}

/** A file's old and new names both there: never merged, nothing written. */
function refuseBothNames(dir: string) {
  for (const [from, to] of RENAMED) {
    if (existsSync(join(dir, from)) && existsSync(join(dir, to))) {
      throw new Error(
        `${from} and ${to} are both in ${dir}: one of them is to go, by hand`
      );
    }
  }
}

async function migrate(dir: string, state: string) {
  refuseBothNames(dir);
  const isRepo = existsSync(join(dir, ".git"));
  if (isRepo) {
    commitMemory(COMMITTED, "Memory: before the names' rename", dir);
  }
  const counts = new Map<string, [number, number]>();
  const add = (key: string, [before, after]: [number, number]) => {
    const [b, a] = counts.get(key) ?? [0, 0];
    counts.set(key, [b + before, a + after]);
  };
  const out = join(state, "memory");
  renamePhotoPrompt(join(out, "photo-descriptions.sqlite"));
  const today = logFileOf(clock().toISOString());
  for (const path of filesIn(join(state, "log"), (n) => LOG_FILE.test(n))) {
    if (!path.endsWith(today)) {
      add("log", rewrite(path, logLine));
    }
  }
  dropKeptGrades(join(out, "fact-check-grades.json"));
  for (const [rel, rule] of rulesOf(toldIdsOf(dir))) {
    for (const path of pathsOf(dir, rel)) {
      add(rel, rewrite(path, jsonLine(rule)));
    }
  }
  for (const kind of ["people", "areas"]) {
    for (const path of filesIn(join(dir, "memory/pages", kind), (n) =>
      n.endsWith(".md")
    )) {
      add(
        "memory/pages",
        rewrite(path, (l) => (l === "## History" ? "## Earlier" : l))
      );
    }
  }
  for (const path of filesIn(join(dir, "docs/evals"), (n) =>
    JUDGE_CASES.test(n)
  )) {
    renameJudgeCases(path);
  }
  for (const [from, to] of RENAMED) {
    if (existsSync(join(dir, from))) {
      renameSync(join(dir, from), join(dir, to));
    }
  }
  for (const f of ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm"]) {
    rmSync(join(out, f), { force: true });
  }
  dropToldPassages(join(out, "passages.sqlite"));
  // The index and the passages are written by this process's own paths: rebuilt only when they are the ones migrated.
  if (real(dir) === OWNER_DATA_DIR && real(state) === LIFE_STATE_DIR) {
    await reindex();
    await writeToldPassages(dir);
  }
  appendFileSync(
    join(dir, DONE),
    `${JSON.stringify({ at: clock().toISOString(), name: STEP, schemaVersion: 1 })}\n`
  );
  if (isRepo) {
    commitMemory(COMMITTED, `Memory: stored names renamed (${STEP})`, dir);
  }
  log("run.end", {
    counts: Object.fromEntries(counts),
    step: `memory.migrate.${STEP}`,
  });
}

/** Another Life's watcher still running (the old app's): it would write the old names meanwhile. */
const otherWatcher = () => {
  const h = holder("watch");
  return h !== null && h.pid !== String(process.pid);
};

/**
 * Runs the migration once, holding memory's lock, while no other watcher runs: every command but the archive waits
 * meanwhile (`migrateFor`). Only the app runs it on his own data (`mayMigrate`): a checkout stops instead.
 */
export async function migrateStored(
  dir = OWNER_DATA_DIR,
  state = LIFE_STATE_DIR
) {
  while (existsSync(join(dir, "memory")) && !isDone(dir)) {
    if (!mayMigrate(dir, state)) {
      throw new Error(
        'his stored names are not renamed yet: only the new Life.app does it (AGENTS.md, "A rename or a new field backfills")'
      );
    }
    if (!runsFromRepo() && otherWatcher()) {
      console.error(
        `The names' rename waits for the watcher of ${holder("watch")?.note} to stop`
      );
      // biome-ignore lint/performance/noAwaitInLoops: waits for the old watcher to stop
      await Bun.sleep(5000);
      continue;
    }
    const ran = await locked(async () => {
      if (!isDone(dir)) {
        await migrate(dir, state);
      }
      return true;
    });
    if (!ran) {
      await Bun.sleep(5000);
    }
  }
}

/**
 * What every command runs first: the settings and today's log renamed (each start, by content), then the stored
 * names, which every command but the archive waits for (the archive never writes memory/, and must not stop).
 */
export async function migrateFor(
  command: string,
  dir = OWNER_DATA_DIR,
  state = LIFE_STATE_DIR
) {
  renameSettings(state);
  renameTodayLog(state);
  if (command !== "archive") {
    await migrateStored(dir, state);
  }
}
