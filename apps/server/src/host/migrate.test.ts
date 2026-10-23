import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { OWNER_DATA_DIR } from "../core/paths";
import { MACHINE_DIR } from "../core/platform";
import { madeBy, unit as unitRecord } from "../memory/record-fixtures";
import { unitId, VOICE_STEP } from "../memory/units";
import { Observation } from "../records/observation";
import { Statement } from "../records/statement";
import { MemoryLabel, Migration, Unit } from "../records/unit";
import { storeFiles, WATCH } from "../sources/voice";
import { migrateStored, renameStored } from "./migrate";

// Made-up memory as it was written before the rename: lifelog's chapter units (one on the day the rename runs, one
// before it), and every record naming the source `lifelog`, beside words that say lifelog and must keep it.
const TODAY = "2026-10-25";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const chapter = (id: string, date: string) => ({
  ...unitRecord({ date, id, key: "conv-1", refs: ["conv-1#ch"] }),
  source: "lifelog",
  summary: "They talk about lifelog.",
  title: "lifelog's title",
});
const OLD_DAY = "unit_00000000000a";
const OF_TODAY = "unit_00000000000b";
const jsonl = (...lines: object[]) =>
  `${lines.map((r) => JSON.stringify(r)).join("\n")}\n`;
const observation = {
  about: "person:me",
  area: null,
  at: "2026-10-20T08:00:00.000Z",
  confidence: 0.8,
  date: "2026-10-20",
  entities: ["project:lifelog"],
  id: "obs_00000000000a",
  importance: 2,
  madeBy: { ...madeBy, unitHash: "0123456789abcdef" },
  quote: "the lifelog app",
  schemaVersion: 1,
  source: { channel: "lifelog", ref: "job-1:0@2026-10-20T08:00:00.000Z" },
  speaker: "person:me",
  text: "He fixes the lifelog app.",
  type: "to_do",
  tz: "Europe/Paris",
  unit: OLD_DAY,
  validFrom: null,
  validTo: null,
  when: null,
};
const statement = {
  at: "2026-10-20T08:00:00.000Z",
  date: "2026-10-20",
  group: "project:lifelog",
  kind: "fact",
  ref: "obs_00000000000a",
  schemaVersion: 1,
  source: "lifelog",
  text: "He fixes the lifelog app.",
  units: [OLD_DAY],
};
const before = new Map([
  [
    "memory/units/2026-10-20.jsonl",
    jsonl(
      chapter(OLD_DAY, "2026-10-20"),
      unitRecord({ id: "unit_00000000000c", key: "lifelog", source: "git" })
    ),
  ],
  ["memory/units/2026-10-25.jsonl", jsonl(chapter(OF_TODAY, TODAY))],
  ["memory/observations/2026-10.jsonl", jsonl(observation)],
  ["memory/statements.jsonl", jsonl(statement)],
  [
    "memory/labels.jsonl",
    jsonl(
      { matters: true, unitId: OLD_DAY },
      { matters: false, unitId: OF_TODAY }
    ),
  ],
  [
    "memory/verdicts.jsonl",
    jsonl({ reason: "lifelog work", topics: ["lifelog"], unit: OLD_DAY }),
  ],
  [
    "docs/evals/clef/cases.json",
    JSON.stringify([{ channel: "lifelog", text: "lifelog said" }]),
  ],
]);

const { files, plan } = renameStored(before, TODAY);
const after = new Map([...before, ...files]);
const rows = (path: string) =>
  (after.get(path) ?? "")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("the source lifelog is voice wherever it is a source's name; words, topics, projects and repos keep theirs", () => {
  expect(rows("memory/units/2026-10-20.jsonl")).toMatchObject([
    {
      id: OLD_DAY,
      source: "voice",
      summary: "They talk about lifelog.",
      title: "lifelog's title",
    },
    { key: "lifelog", source: "git" },
  ]);
  expect(rows("memory/observations/2026-10.jsonl")).toEqual([
    { ...observation, source: { ...observation.source, channel: "voice" } },
  ]);
  expect(rows("memory/statements.jsonl")).toEqual([
    { ...statement, source: "voice" },
  ]);
  expect(files.has("memory/verdicts.jsonl")).toBe(false);
  expect(JSON.parse(after.get("docs/evals/clef/cases.json") ?? "")).toEqual([
    { channel: "voice", text: "lifelog said" },
  ]);
});

test("a label on one of today's chapters moves to its conversation-day; an older chapter keeps its id; the cutover is today", () => {
  expect(rows("memory/labels.jsonl")).toEqual([
    { matters: true, unitId: OLD_DAY },
    { matters: false, unitId: unitId("voice", "conv-1", TODAY) },
  ]);
  expect(plan.cutover).toBe(TODAY);
  // An install that never had lifelog's chapters has no cutover: every voice unit is a conversation-day.
  expect(
    renameStored(new Map([["memory/statements.jsonl", ""]]), TODAY).plan.cutover
  ).toBeUndefined();
});

test("every line keeps its place, renamed records parse, and run again it changes nothing", () => {
  for (const [path, text] of [...files].filter(([p]) => p.endsWith(".jsonl"))) {
    expect(text.split("\n")).toHaveLength(
      (before.get(path) ?? "").split("\n").length
    );
  }
  const parsers: [string, z.ZodType][] = [
    ["memory/observations/2026-10.jsonl", Observation],
    ["memory/statements.jsonl", Statement],
    ["memory/labels.jsonl", MemoryLabel],
    ["memory/units/2026-10-25.jsonl", Unit],
  ];
  for (const [path, schema] of parsers) {
    for (const r of rows(path)) {
      expect(() => schema.parse(r)).not.toThrow();
    }
  }
  expect([...renameStored(after, TODAY).files.keys()]).toEqual([]);
});

/** A data dir holding `before`, plus `extra` files. */
function dataDir(extra: [string, string][] = []) {
  const dir = mkdtempSync(join(tmpdir(), "life-rename-"));
  for (const [path, text] of [...before, ...extra]) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const read = (dir: string, path: string) =>
  readFileSync(join(dir, path), "utf8");
const rowsAt = (dir: string, path: string) =>
  read(dir, path)
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("in a data dir: renamed once and recorded with its cutover; run again, nothing moves", async () => {
  const dir = dataDir();
  await migrateStored(dir);
  const [done] = rowsAt(dir, "memory/migrations.jsonl");
  expect(Migration.parse(done)).toMatchObject({ name: VOICE_STEP });
  expect(done.cutover).toMatch(DATE);
  expect(read(dir, "memory/statements.jsonl")).toContain('"source":"voice"');
  const once = read(dir, "memory/units/2026-10-20.jsonl");
  await migrateStored(dir);
  expect(read(dir, "memory/units/2026-10-20.jsonl")).toBe(once);
  expect(rowsAt(dir, "memory/migrations.jsonl")).toHaveLength(1);
});

test("a checkout's rename of its own copy never waits for another Life's watcher, and moves the store once, titles blanked", async () => {
  // Another Life's watcher, alive (this test's parent process), as the app's would be while the demo runs.
  const lock = join(MACHINE_DIR, "watch.lock");
  mkdirSync(MACHINE_DIR, { recursive: true });
  writeFileSync(lock, `${process.ppid}\n/elsewhere/state`);
  mkdirSync(WATCH, { recursive: true });
  const old = new Database(join(WATCH, "lifelog.sqlite"));
  old.run("create table conversations (id text primary key, title text)");
  old.run("insert into conversations values ('c1', 'A model title')");
  old.close();
  try {
    await migrateStored(OWNER_DATA_DIR);
    expect(read(OWNER_DATA_DIR, "memory/migrations.jsonl")).toContain(
      VOICE_STEP
    );
    expect(existsSync(join(WATCH, "lifelog.sqlite"))).toBe(false);
    const db = new Database(storeFiles().file, { readonly: true });
    expect(db.query("select id, title from conversations").all()).toEqual([
      { id: "c1", title: "" },
    ]);
    db.close();
  } finally {
    rmSync(lock, { force: true });
    rmSync(storeFiles().file, { force: true });
  }
});

test("a run cut off while building is built again; memory/ was never touched", async () => {
  const dir = dataDir([["memory.renamed/units/x.jsonl", "half"]]);
  await migrateStored(dir);
  expect(existsSync(join(dir, "memory.renamed"))).toBe(false);
  expect(existsSync(join(dir, "memory/units/x.jsonl"))).toBe(false);
  expect(read(dir, "memory/statements.jsonl")).toContain('"source":"voice"');
});

/** The state right after the swap: the new memory in place, the old one beside it. */
function swapped() {
  const dir = dataDir();
  renameSync(join(dir, "memory"), join(dir, "memory.old"));
  for (const [path, text] of before) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), files.get(path) ?? text);
  }
  writeFileSync(
    join(dir, "memory/migrations.jsonl"),
    `${JSON.stringify({ at: `${TODAY}T08:00:00.000Z`, cutover: TODAY, name: VOICE_STEP, schemaVersion: 1 })}\n`
  );
  return dir;
}
const late = jsonl({ ...statement, ref: "obs_00000000000b" });

test("a run cut off after the swap is settled: a late line renamed onto the new memory, once, the old copy gone", async () => {
  const dir = swapped();
  appendFileSync(join(dir, "memory.old/statements.jsonl"), late);
  // Cut off again mid-settle: the old copy is still there; settled twice, nothing is added twice.
  const copy = mkdtempSync(join(tmpdir(), "life-old-"));
  cpSync(join(dir, "memory.old"), copy, { recursive: true });
  await migrateStored(dir);
  cpSync(copy, join(dir, "memory.old"), { recursive: true });
  await migrateStored(dir);
  const all = rowsAt(dir, "memory/statements.jsonl");
  expect(all).toHaveLength(2);
  expect(all[1]).toEqual({
    ...statement,
    ref: "obs_00000000000b",
    source: "voice",
  });
  expect(existsSync(join(dir, "memory.old"))).toBe(false);
});

test("a memory/ made between the two renames is kept and settled, never dropped", async () => {
  const dir = swapped();
  // Back to the moment between the renames: the new memory not yet in place, a stray memory/ written meanwhile.
  renameSync(join(dir, "memory"), join(dir, "memory.renamed"));
  mkdirSync(join(dir, "memory"));
  writeFileSync(join(dir, "memory/statements.jsonl"), late);
  await migrateStored(dir);
  expect(rowsAt(dir, "memory/statements.jsonl")).toHaveLength(2);
  expect(read(dir, "memory/units/2026-10-20.jsonl")).toContain(
    '"source":"voice"'
  );
  for (const d of ["memory.old", "memory.renamed", "memory.stray"]) {
    expect(existsSync(join(dir, d))).toBe(false);
  }
});
