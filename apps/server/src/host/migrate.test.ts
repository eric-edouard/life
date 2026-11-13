import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clock } from "../core/clock";
import { logFileOf } from "../core/log";
import { MACHINE_DIR } from "../core/platform";
import { git } from "../core/proc";
import { unitId } from "../memory/units";
import {
  mayMigrate,
  migrateFor,
  migrateStored,
  renameSettings,
} from "./migrate";

/** A file of one line. */
const ONE_LINE = /^[^\n]+\n$/;
const DAY = "2026-10-12";
const OLD = unitId("told", "told", DAY);
const NEW = unitId("told-life", "told-life", DAY);
const OTHER = "unit_00000000000b";
const PAST_LOG = "log/2026-10-12.jsonl";
const TODAY_LOG = `log/${logFileOf(clock().toISOString())}`;

const jsonl = (...rows: object[]) =>
  rows.map((r) => `${JSON.stringify(r)}\n`).join("");
const at = "2026-10-12T08:00:00.000Z";
const madeBy = (prompt: string) => ({
  engine: "codex",
  model: "m",
  prompt,
  run: "r",
});

/** Every stored name the migration renames, old (left) and what it must become (right), one made-up line or more each. */
const DATA: Record<string, [string, string]> = {
  "docs/evals/judge-cases-a.json": [
    `${JSON.stringify({ cases: [{ claims: [{ id: "obs_1", text: "x" }], expect: "stated", fact: "f", id: "c1", why: "w" }] }, null, 2)}\n`,
    `${JSON.stringify({ cases: [{ expect: "stated", fact: "f", id: "c1", memoryLines: [{ id: "obs_1", text: "x" }], why: "w" }] }, null, 2)}\n`,
  ],
  "memory/closeness.jsonl": [
    jsonl(
      { madeBy: madeBy("closeness.v1"), person: "person:ana" },
      { madeBy: madeBy("other.v1") }
    ),
    jsonl(
      { madeBy: madeBy("memory-closeness.v1"), person: "person:ana" },
      { madeBy: madeBy("other.v1") }
    ),
  ],
  "memory/corrections.jsonl": [
    jsonl(
      { kind: "keep-mine", page: "person:ana", section: "history", text: "t" },
      { kind: "keep-mine", page: "person:ana", section: "bond", text: "t" },
      { kind: "this-is", person: "person:ana", surface: "+10000000000" },
      { kind: "not-this-person", person: "person:ana", surface: "Ana B" },
      { kind: "reread", units: [OLD, OTHER] },
      { kind: "keep-mine", page: "person:ana", section: "now", text: "t" }
    ),
    jsonl(
      { kind: "keep-mine", page: "person:ana", section: "earlier", text: "t" },
      {
        kind: "keep-mine",
        page: "person:ana",
        section: "between_us",
        text: "t",
      },
      { kind: "this-is", nameOrHandle: "+10000000000", person: "person:ana" },
      { kind: "not-this-person", nameOrHandle: "Ana B", person: "person:ana" },
      { kind: "reread", units: [NEW, OTHER] },
      { kind: "keep-mine", page: "person:ana", section: "now", text: "t" }
    ),
  ],
  "memory/episodes/2026-10-12.jsonl": [
    jsonl({
      copies: [OLD],
      id: "ep_1",
      people: [{ ref: "person:ana", role: "told" }],
      units: [OTHER, OLD],
    }),
    jsonl({
      copies: [NEW],
      id: "ep_1",
      people: [{ ref: "person:ana", role: "told" }],
      units: [OTHER, NEW],
    }),
  ],
  "memory/extracted.jsonl": [
    jsonl({ unit: OLD }, { unit: OTHER }),
    jsonl({ unit: NEW }, { unit: OTHER }),
  ],
  "memory/files.jsonl": [
    jsonl(
      { hash: "h", madeBy: madeBy("files.v1"), ref: "f", what: "A receipt." },
      { hash: "h2", ref: "g", text: "words" }
    ),
    jsonl(
      {
        description: "A receipt.",
        hash: "h",
        madeBy: madeBy("message-file-description.v1"),
        ref: "f",
      },
      { hash: "h2", ref: "g", text: "words" }
    ),
  ],
  "memory/imported.jsonl": [
    jsonl({ madeBy: madeBy("import.v1") }),
    jsonl({ madeBy: madeBy("import-keep.v1") }),
  ],
  "memory/labels.jsonl": [
    // The second line is already new: a run that stopped halfway is finished.
    jsonl({ matters: true, unitId: OLD }, { important: false, unitId: OTHER }),
    jsonl(
      { important: true, unitId: NEW },
      { important: false, unitId: OTHER }
    ),
  ],
  "memory/ledger.jsonl": [
    jsonl(
      {
        after: { on: true },
        id: "entry_000000000001",
        kind: "grant",
        target: "grant",
        via: "session",
      },
      {
        after: { link: "x-1", title: "Milk" },
        id: "entry_000000000002",
        kind: "add",
        target: "reminder:1",
        via: "connector",
      },
      {
        after: { done: true },
        id: "entry_000000000003",
        kind: "done",
        target: "reminder:1",
        via: "reminders",
      },
      {
        after: { title: "t" },
        id: "entry_000000000004",
        kind: "ask",
        target: "agent",
        via: madeBy("reminders"),
      }
    ),
    jsonl(
      {
        after: { on: true },
        id: "entry_000000000001",
        kind: "auto_add",
        target: "auto_add",
        via: "session",
      },
      {
        after: { deepLinkId: "x-1", title: "Milk" },
        id: "entry_000000000002",
        kind: "add",
        target: "reminder:1",
        via: "connector",
      },
      {
        after: { done: true },
        id: "entry_000000000003",
        kind: "done",
        target: "reminder:1",
        via: "todo_list",
      },
      {
        after: { title: "t" },
        id: "entry_000000000004",
        kind: "ask",
        target: "agent",
        via: madeBy("reminders"),
      }
    ),
  ],
  "memory/observations/2026-10.jsonl": [
    jsonl(
      {
        entities: ["person:ana"],
        id: "obs_000000000001",
        source: { channel: "told", ref: `told:${at}` },
        unit: OLD,
      },
      {
        entities: [],
        id: "obs_000000000002",
        source: { channel: "whatsapp", ref: "told:x" },
        unit: OTHER,
      }
    ),
    jsonl(
      {
        id: "obs_000000000001",
        source: { channel: "told-life", ref: `told-life:${at}` },
        subjects: ["person:ana"],
        unit: NEW,
      },
      {
        id: "obs_000000000002",
        source: { channel: "whatsapp", ref: "told:x" },
        subjects: [],
        unit: OTHER,
      }
    ),
  ],
  "memory/pages/people/ana.md": [
    "# Ana\n\n## Now\n\n- a line about History\n\n## History\n\n- 2026-10-01 · old\n",
    "# Ana\n\n## Now\n\n- a line about History\n\n## Earlier\n\n- 2026-10-01 · old\n",
  ],
  "memory/people-contacts.jsonl": [
    jsonl({ card: "c", name: "Ana", surfaces: ["+1"] }),
    jsonl({ card: "c", handles: ["+1"], name: "Ana" }),
  ],
  "memory/people-inferred.jsonl": [
    jsonl({
      evidence: [
        { quote: "q", unit: OLD },
        { quote: "r", unit: OTHER },
      ],
      id: "inf_a",
      surfaces: ["Bo"],
    }),
    jsonl({
      evidence: [
        { quote: "q", unit: NEW },
        { quote: "r", unit: OTHER },
      ],
      id: "inf_a",
      namesAndHandles: ["Bo"],
    }),
  ],
  "memory/publications.jsonl": [
    jsonl({ sources: ["whatsapp", "told"] }),
    jsonl({ sources: ["whatsapp", "told-life"] }),
  ],
  "memory/ratings.jsonl": [
    jsonl({ answer: "true", ref: "obs_000000000001" }),
    jsonl({ answer: "true", ref: "obs_000000000001" }),
  ],
  "memory/read-replies/2026-10.jsonl": [
    jsonl({ read: "conflict", wording: "0123456789abcdef" }),
    jsonl({ promptDigest: "0123456789abcdef", read: "conflict" }),
  ],
  "memory/repos-inferred.jsonl": [
    jsonl({ madeBy: madeBy("repos.v1") }),
    jsonl({ madeBy: madeBy("repo-project.v1") }),
  ],
  "memory/scores.jsonl": [
    jsonl({ held: 1, rated: 3 }),
    jsonl({ answered: 3, held: 1 }),
  ],
  "memory/statements.jsonl": [
    jsonl(
      { ref: "obs_000000000001", source: "told", units: [OLD] },
      { ref: "obs_000000000002", source: "whatsapp", units: [OTHER] }
    ),
    jsonl(
      { ref: "obs_000000000001", source: "told-life", units: [NEW] },
      { ref: "obs_000000000002", source: "whatsapp", units: [OTHER] }
    ),
  ],
  "memory/told.jsonl": [
    jsonl({ at, said: "s", schemaVersion: 1 }),
    jsonl({ at, said: "s", schemaVersion: 1 }),
  ],
  "memory/units/2026-10-12.jsonl": [
    jsonl(
      {
        id: OLD,
        key: "told",
        marked: [`told:${at}`],
        refs: [`told:${at}#asked`, `told:${at}`],
        source: "told",
      },
      { id: OTHER, key: "told", refs: ["told:m1"], source: "whatsapp" }
    ),
    jsonl(
      {
        id: NEW,
        key: "told-life",
        marked: [`told-life:${at}`],
        refs: [`told-life:${at}#asked`, `told-life:${at}`],
        source: "told-life",
      },
      { id: OTHER, key: "told", refs: ["told:m1"], source: "whatsapp" }
    ),
  ],
  "memory/unresolved.jsonl": [
    jsonl({ surface: "Bo", unit: OLD, via: "model" }),
    jsonl({ nameAsWritten: "Bo", unit: NEW, via: "model" }),
  ],
  "memory/verdicts.jsonl": [
    jsonl({ unit: OLD }, { unit: OTHER }),
    jsonl({ unit: NEW }, { unit: OTHER }),
  ],
};
/** Where a file of DATA lands: renamed whole (S1, S2, S14), else where it was. */
const MOVED: Record<string, string> = {
  "memory/ratings.jsonl": "memory/fact-check-answers.jsonl",
  "memory/statements.jsonl": "memory/fact-checks.jsonl",
  "memory/told.jsonl": "memory/told-life.jsonl",
};
const STATE: Record<string, [string, string]> = {
  [PAST_LOG]: [
    `${jsonl({ at, kind: "run.phase", phase: "extract", step: "memory.nightly" }, { at, kind: "run.end", step: "memory.nightly" })}{"kind":"run.phase" not json\n`,
    `${jsonl({ at, entered: "extract", kind: "run.entered", step: "memory.nightly" }, { at, kind: "run.end", step: "memory.nightly" })}{"kind":"run.phase" not json\n`,
  ],
  [TODAY_LOG]: [
    jsonl({ at, kind: "run.phase", phase: "pages", step: "s" }),
    jsonl({ at, entered: "pages", kind: "run.entered", step: "s" }),
  ],
  "settings.json": [
    `${JSON.stringify({ engine: "codex", past: { calendar: "Past" }, repos: "~/Work", sources: ["told", "mail"], todo_list: { backend: "reminders" } }, null, 2)}\n`,
    `${JSON.stringify({ engine: "codex", pastCalendar: { calendar: "Past" }, reposFolder: "~/Work", sources: ["told-life", "mail"], todoList: { backend: "reminders" } }, null, 2)}\n`,
  ],
};

/** A made-up file's old and new text. */
const pair = (table: Record<string, [string, string]>, f: string) => {
  const p = new Map(Object.entries(table)).get(f);
  if (!p) {
    throw new Error(`no made-up ${f}`);
  }
  return p;
};
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
/** A made-up data folder and state folder holding the old names, with photo descriptions, kept grades and passages. */
function made() {
  const root = mkdtempSync(join(tmpdir(), "life-migrate-"));
  const dir = join(root, "data");
  const state = join(root, "state");
  for (const [f, [old]] of Object.entries(DATA)) {
    put(join(dir, f), old);
  }
  for (const [f, [old]] of Object.entries(STATE)) {
    put(join(state, f), old);
  }
  mkdirSync(join(state, "memory"), { recursive: true });
  const photos = new Database(join(state, "memory/photo-descriptions.sqlite"));
  photos.run(
    "create table descriptions (uuid text, prompt text, primary key (uuid, prompt))"
  );
  photos.run(
    "insert into descriptions values ('p1', 'photos.v1'), ('p2', 'other.v1')"
  );
  photos.close();
  const passages = new Database(join(state, "memory/passages.sqlite"));
  passages.run("create table passages (id text primary key, source text)");
  passages.run("create table coverage (source text, start text)");
  passages.run(
    "insert into passages values ('told|told:1', 'told'), ('whatsapp|m1', 'whatsapp')"
  );
  passages.run("insert into coverage values ('told', 'a'), ('whatsapp', 'a')");
  passages.close();
  put(
    join(state, "memory/fact-check-grades.json"),
    JSON.stringify({
      obs_1: { cited: [], grade: { claims: [], fact: "f" }, key: "k" },
    })
  );
  put(join(state, "memory/index.sqlite"), "old index");
  return { dir, root, state };
}

/** Every file under `root` but the sqlite ones, by path. */
const snapshot = (root: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(root, { recursive: true })
      .map(String)
      .filter((f) => !f.includes(".sqlite") && statSync(join(root, f)).isFile())
      .map((f) => [f, readFileSync(join(root, f), "utf8")])
  );
const rowsOf = (path: string, sql: string) => {
  const db = new Database(path);
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
};

test("every stored name is renamed line for line, the told units by their days; a second run changes no byte", async () => {
  const { dir, root, state } = made();
  await migrateStored(dir, state);
  for (const [f, [, now]] of Object.entries(DATA)) {
    expect(readFileSync(join(dir, MOVED[f] ?? f), "utf8")).toBe(now);
  }
  for (const f of Object.keys(MOVED)) {
    expect(existsSync(join(dir, f))).toBe(false);
  }
  // Today's log waits for the start (`migrateFor`); the settings too.
  expect(readFileSync(join(state, PAST_LOG), "utf8")).toBe(
    pair(STATE, PAST_LOG)[1]
  );
  expect(readFileSync(join(state, TODAY_LOG), "utf8")).toBe(
    pair(STATE, TODAY_LOG)[0]
  );
  expect(
    rowsOf(
      join(state, "memory/photo-descriptions.sqlite"),
      "select * from descriptions order by uuid"
    )
  ).toEqual([
    { prompt: "photo-description.v1", uuid: "p1" },
    { prompt: "other.v1", uuid: "p2" },
  ]);
  expect(
    rowsOf(join(state, "memory/passages.sqlite"), "select * from passages")
  ).toEqual([{ id: "whatsapp|m1", source: "whatsapp" }]);
  expect(
    rowsOf(join(state, "memory/passages.sqlite"), "select source from coverage")
  ).toEqual([{ source: "whatsapp" }]);
  expect(existsSync(join(state, "memory/fact-check-grades.json"))).toBe(false);
  expect(existsSync(join(state, "memory/index.sqlite"))).toBe(false);
  const once = snapshot(root);
  await migrateStored(dir, state);
  expect(snapshot(root)).toEqual(once);
  // Its done line gone (a crash before it was written): every rule again leaves every line as it is.
  rmSync(join(dir, "memory/migrations.jsonl"));
  await migrateStored(dir, state);
  const { "data/memory/migrations.jsonl": done, ...again } = snapshot(root);
  const { "data/memory/migrations.jsonl": _, ...first } = once;
  expect(again).toEqual(first);
  expect(done).toMatch(ONE_LINE);
  expect(
    rowsOf(
      join(state, "memory/photo-descriptions.sqlite"),
      "select prompt from descriptions order by uuid"
    )
  ).toEqual([{ prompt: "photo-description.v1" }, { prompt: "other.v1" }]);
});

test("a start after a crash finishes: units already new, a citing file still old, a file not yet renamed", async () => {
  const { dir, state } = made();
  put(
    join(dir, "memory/units/2026-10-12.jsonl"),
    pair(DATA, "memory/units/2026-10-12.jsonl")[1]
  );
  put(
    join(dir, "memory/fact-checks.jsonl"),
    pair(DATA, "memory/statements.jsonl")[0]
  );
  rmSync(join(dir, "memory/statements.jsonl"));
  await migrateStored(dir, state);
  expect(readFileSync(join(dir, "memory/verdicts.jsonl"), "utf8")).toBe(
    pair(DATA, "memory/verdicts.jsonl")[1]
  );
  expect(readFileSync(join(dir, "memory/fact-checks.jsonl"), "utf8")).toBe(
    pair(DATA, "memory/statements.jsonl")[1]
  );
  expect(readFileSync(join(dir, "memory/units/2026-10-12.jsonl"), "utf8")).toBe(
    pair(DATA, "memory/units/2026-10-12.jsonl")[1]
  );
});

test("a file under both its old and new names stops it, nothing written", async () => {
  const { dir, root, state } = made();
  put(join(dir, "memory/told-life.jsonl"), "");
  const before = snapshot(root);
  await expect(migrateStored(dir, state)).rejects.toThrow("both");
  expect(snapshot(root)).toEqual(before);
});

test("the start renames the settings and today's log, and the archive starts without the memory's steps", async () => {
  const { dir, state } = made();
  await migrateFor("archive", dir, state);
  expect(readFileSync(join(state, "settings.json"), "utf8")).toBe(
    pair(STATE, "settings.json")[1]
  );
  expect(readFileSync(join(state, TODAY_LOG), "utf8")).toBe(
    pair(STATE, TODAY_LOG)[1]
  );
  expect(existsSync(join(dir, "memory/migrations.jsonl"))).toBe(false);
  expect(readFileSync(join(dir, "memory/labels.jsonl"), "utf8")).toBe(
    pair(DATA, "memory/labels.jsonl")[0]
  );
  await migrateFor("status", dir, state);
  expect(existsSync(join(dir, "memory/migrations.jsonl"))).toBe(true);
});

test("settings: an old copy met after the data was migrated is renamed; both names stop it; the app's, from a checkout, is untouched", async () => {
  const { dir, state } = made();
  await migrateStored(dir, state);
  renameSettings(state);
  expect(readFileSync(join(state, "settings.json"), "utf8")).toBe(
    pair(STATE, "settings.json")[1]
  );
  put(
    join(state, "settings.json"),
    JSON.stringify({
      todo_list: { backend: "reminders" },
      todoList: { backend: "reminders" },
    })
  );
  expect(() => renameSettings(state)).toThrow("todo_list and todoList");
  const app = join(MACHINE_DIR, "state");
  put(join(app, "settings.json"), pair(STATE, "settings.json")[0]);
  renameSettings(app);
  expect(readFileSync(join(app, "settings.json"), "utf8")).toBe(
    pair(STATE, "settings.json")[0]
  );
  rmSync(app, { force: true, recursive: true });
});

test("a checkout never migrates his own data or the app's state; a copy it does", async () => {
  const { dir, state } = made();
  expect(mayMigrate(join(homedir(), "Life"), state)).toBe(false);
  expect(mayMigrate(dir, state)).toBe(true);
  await expect(migrateStored(dir, join(MACHINE_DIR, "state"))).rejects.toThrow(
    "only the new Life.app"
  );
});

test("in a repo, the commits before and after: the after one holds the renames and the judge cases", async () => {
  const { dir, state } = made();
  const run = (...args: string[]) => git(dir, args).stdout.toString();
  run("init", "-q");
  run("config", "user.email", "test@example.test");
  run("config", "user.name", "Test");
  await migrateStored(dir, state);
  expect(run("log", "--format=%s").trim().split("\n")).toEqual([
    "Memory: stored names renamed (names-2026-11)",
    "Memory: before the names' rename",
  ]);
  const changed = run("show", "--name-status", "--format=", "-M", "HEAD");
  expect(changed).toContain("docs/evals/judge-cases-a.json");
  expect(changed).toContain("memory/fact-checks.jsonl");
  expect(run("status", "--porcelain", "--", "memory", "docs")).toBe("");
});
