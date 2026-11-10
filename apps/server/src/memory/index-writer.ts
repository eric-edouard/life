import { Database } from "bun:sqlite";
import { clock } from "../core/clock";
import { EMBEDDER_MODEL, textHashOf } from "../core/embedder";
import { newestIn } from "../core/files";
import { openReadOnly } from "../core/sqlite";
import type { Episode } from "../records/episode";
import type { Observation } from "../records/observation";
import type { Unit, Verdict } from "../records/unit";
import {
  CURRENT,
  episodeTextNow,
  OBSERVATION_TEXT,
  UNIT_TEXT,
} from "./index-rows";
import {
  daysOf,
  episodesWhere,
  INDEX,
  MEMORY,
  readIndex,
  readUnits,
  readVerdicts,
  type Standing,
  stateOf,
  type Verdicts,
  verdictOf,
} from "./ledger";
import { readPassageTexts } from "./passages";
import { TRUTH } from "./read-truth";
import type { Searched } from "./vectors";
import { observationsNow, type People, readPeople, unitNow } from "./who";

// derived/memory/index.sqlite: the one writer of the index the read path reads (`buildIndex`, `reindex`,
// `reindexUnits`), when it is stale (`readStaleness`), and every text `search` ranks by meaning (`readSearchedTexts`).

const FTS = "tokenize = 'unicode61 remove_diacritics 2'";
const INDEX_SCHEMA = `
create table observations (
  id text primary key, unit text, date text, at text, type text, area text, importance integer, confidence real,
  speaker text, channel text, ref text, text text, quote text, valid_from text, valid_to text, "when" text,
  superseded_by text);
create virtual table search using fts5(id unindexed, text, quote, ${FTS});
create table links (observation text, entity text, primary key (observation, entity));
create index links_entity on links (entity);
create table units (
  id text primary key, date text, source text, title text, importance integer, type text, area text, topics text);
create virtual table unit_search using fts5(id unindexed, title, summary, topics, ${FTS});
create table unit_topics (unit text, topic text, primary key (unit, topic));
create table unit_people (unit text, person text, primary key (unit, person));
create index unit_topics_topic on unit_topics (topic);
create table search_hashes (id text primary key, hash text not null);
create table rebuilt (at text);`;

/** The supersession that retired `o`, if any (`stateOf`). */
function retirement(o: Observation, standing: Standing) {
  const s = stateOf(o, standing);
  return s.state === "retired" ? s : null;
}

/** A unit and its verdict, as the index holds them. */
interface IndexedUnit {
  unit: Unit;
  verdict?: Verdict;
}

/** The index rows of `units`: who each is with as of today (the table keeps each once), and its verdict. */
const indexedOf = (units: Unit[], people: People, verdicts: Verdicts) =>
  units.map((unit) => ({
    unit: unitNow(unit, people.refOf),
    verdict: verdictOf(verdicts, unit),
  }));

/** `insert or ignore` into `db`'s `table` of `n` columns. */
const insertInto = (db: Database, table: string, n: number) =>
  db.prepare(
    `insert or ignore into ${table} values (${new Array(n).fill("?").join(", ")})`
  );

/**
 * Writes the index at `path` in one write-ahead-log transaction, so a reader holding the file keeps the old rows until
 * the commit and sees the new ones after it; a write waits for another to commit.
 */
function writeIndex(path: string, write: (db: Database) => void) {
  const db = new Database(path);
  db.run("pragma busy_timeout = 30000");
  db.run("pragma journal_mode = wal");
  try {
    db.transaction(() => write(db)).immediate();
  } finally {
    // `true`: every statement is finalized first, so the file is let go (and its log checkpointed) at once.
    db.close(true);
  }
}

/** The units' rows: titles, a chapter's or repo-day's summary, the topics of their verdicts, their people. */
function indexUnits(db: Database, units: IndexedUnit[]) {
  const unitRow = insertInto(db, "units", 8);
  const unitText = insertInto(db, "unit_search", 4);
  const unitTopic = insertInto(db, "unit_topics", 2);
  const unitPerson = insertInto(db, "unit_people", 2);
  const hash = insertInto(db, "search_hashes", 2);
  for (const { unit: u, verdict: v } of units) {
    const tags = v?.topics ?? [];
    unitRow.run(
      u.id,
      u.date,
      u.source,
      u.title,
      v?.importance ?? null,
      v?.type ?? null,
      v?.area ?? null,
      tags.join(", ")
    );
    unitText.run(u.id, u.title, u.summary ?? "", tags.join(" "));
    hash.run(
      u.id,
      textHashOf(
        EMBEDDER_MODEL,
        `${u.title}\n${u.summary ?? ""}\n${tags.join(" ")}`
      )
    );
    for (const t of tags) {
      unitTopic.run(u.id, t);
    }
    for (const p of u.people) {
      unitPerson.run(u.id, p);
    }
  }
}

/**
 * derived/memory/index.sqlite, rebuilt from scratch (`writeIndex`): observations (with the observation that replaced
 * each retired one, and its end date), full-text search over claims and quotes, links; the units (`indexUnits`), so
 * today's material is searchable before the nightly pass; and `rebuilt`, when its reads began (`readStaleness`).
 */
export function buildIndex(
  observations: Observation[],
  path: string,
  standing: Standing,
  units: IndexedUnit[] = [],
  builtAt = clock(),
  episodes: Episode[] = []
) {
  const unique = new Map(observations.map((o) => [o.id, o]));
  writeIndex(path, (db) => {
    // Every table the file holds, whatever schema built it (a virtual table takes its shadow tables along).
    const tables = db
      .query<[string], []>(
        "select name from pragma_table_list where schema = 'main' and type in ('table', 'virtual') and name not like 'sqlite_%'"
      )
      .values();
    db.run(tables.map(([t]) => `drop table "${t}";`).join("") + INDEX_SCHEMA);
    db.run("insert into rebuilt values (?)", [builtAt.toISOString()]);
    const row = insertInto(db, "observations", 17);
    const text = insertInto(db, "search", 3);
    const link = insertInto(db, "links", 2);
    const hash = insertInto(db, "search_hashes", 2);
    for (const episode of episodes) {
      hash.run(episode.id, textHashOf(EMBEDDER_MODEL, episodeTextNow(episode)));
    }
    for (const o of unique.values()) {
      const retired = retirement(o, standing);
      row.run(
        o.id,
        o.unit,
        o.date,
        o.at,
        o.type,
        o.area,
        o.importance,
        o.confidence,
        o.speaker,
        o.source.channel,
        o.source.ref,
        o.text,
        o.quote,
        o.validFrom,
        retired?.validTo ?? o.validTo,
        o.when,
        retired?.by ?? null
      );
      text.run(o.id, o.text, o.quote);
      hash.run(o.id, textHashOf(EMBEDDER_MODEL, `${o.text}\n${o.quote}`));
      for (const e of o.entities) {
        link.run(o.id, e);
      }
    }
    indexUnits(db, units);
  });
  return unique.size;
}

/**
 * Every text `search` ranks by meaning, with when it happened: what the watcher embeds (`embedNew`). Whole when the
 * index and every source were read: only then may vectors of texts not among them go (`pruneVectors`).
 */
export async function readSearchedTexts(): Promise<{
  isWhole: boolean;
  texts: Searched[];
}> {
  const episodes = await episodesWhere(() => true);
  const indexed = readIndex((db) => [
    ...db
      .query<Searched, []>(
        `select o.date as at, h.hash, ${OBSERVATION_TEXT} as text from observations o join search_hashes h on h.id = o.id where ${CURRENT}`
      )
      .all(),
    ...db
      .query<Searched, []>(
        `select u.date as at, h.hash, ${UNIT_TEXT} as text from unit_search s join units u on u.id = s.id join search_hashes h on h.id = u.id`
      )
      .all(),
  ]);
  const chats = readPassageTexts();
  return {
    isWhole: indexed !== null && chats.isWhole,
    texts: [
      ...(indexed ?? []),
      ...episodes.map((m) => ({ at: daysOf(m)[0], text: episodeTextNow(m) })),
      ...chats.texts,
    ],
  };
}

/** Rebuilds the index from the ledger and the units; what the owner said is wrong or unimportant is not searchable. */
export async function reindex() {
  const at = clock();
  const [people, verdicts] = await Promise.all([readPeople(), readVerdicts()]);
  const units = indexedOf(await readUnits(), people, verdicts);
  const { observations, standing } = await observationsNow(people);
  const n = buildIndex(
    observations,
    INDEX,
    standing,
    units,
    at,
    await episodesWhere(() => true)
  );
  // On stderr: the app reads a command's stdout as its answer, and the first command after an update may rebuild.
  console.error(
    `${n} observations and ${units.length} units indexed in ${INDEX}`
  );
}

/**
 * Rewrites the rows of `units` alone, units the watcher wrote (`syncLifelogUnits`): the observations on them stand as
 * they did, so the full rebuild's rows hold. A unit that went, or that a code rule dropped or took back, takes the full
 * `reindex`.
 */
export async function reindexUnits(units: Unit[], path = INDEX) {
  const [people, verdicts] = await Promise.all([readPeople(), readVerdicts()]);
  const ids = JSON.stringify(units.map((u) => u.id));
  writeIndex(path, (db) => {
    for (const [table, id] of [
      ["units", "id"],
      ["unit_search", "id"],
      ["unit_topics", "unit"],
      ["unit_people", "unit"],
      ["search_hashes", "id"],
    ]) {
      db.run(
        `delete from ${table} where ${id} in (select value from json_each(?))`,
        [ids]
      );
    }
    indexUnits(db, indexedOf(units, people, verdicts));
  });
}

/**
 * What changed since the full rebuild's reads began (its `rebuilt` row), so a correction is searchable within the
 * minute: `truth` (a file under truth/ newer: the lifelog units carry its names, so they are built again too), `index`
 * (any other file under memory/ newer, units/ and episodes/ aside, which the watcher writes itself; or no index, or one
 * from before the row), or null. A superset of what the rebuild reads: a list of its inputs would drift.
 */
export function readStaleness(path = INDEX): "truth" | "index" | null {
  let rebuilt: string | undefined;
  try {
    const db = openReadOnly(path);
    try {
      rebuilt = db
        .query<{ at: string }, []>("select at from rebuilt")
        .get()?.at;
      // A pre-hash index must rebuild even when none of its source files changed.
      db.query("select id from search_hashes limit 0").all();
    } finally {
      db.close();
    }
  } catch {
    return "index";
  }
  const at = rebuilt ? Date.parse(rebuilt) : 0;
  if (newestIn(TRUTH) > at) {
    return "truth";
  }
  return !rebuilt || newestIn(MEMORY, ["units", "episodes"]) > at
    ? "index"
    : null;
}
