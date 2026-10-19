import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { redact } from "../redact";
import {
  type Action,
  INFERRED_USE_AT,
  KEEP_AT,
  type Moment,
  type Observation,
  type Unit,
  type Verdict,
} from "../schema";
import {
  conversationsWith,
  type LifelogConversation,
  readConversations,
  searchVoice,
  speakers,
  turnOffset,
  withStore,
} from "../sources/lifelog";
import { loadTruth, OWNER } from "../truth";
import {
  daysOf,
  momentsNow,
  OUT,
  PAGES,
  readActions,
  readCorrections,
  readMoments,
  readUnits,
  readUnresolved,
  readVerdicts,
  type Standing,
  stateOf,
  verdictOf,
} from "./ledger";
import { who as named, SURE_AT } from "./observe";
import { digestOf, type PageMeta, parsePage } from "./page";
import { asData, chatHits, holdsAll } from "./raw";
import { actionLine } from "./report";
import {
  clip,
  dayRange,
  lifelogNames,
  localTime,
  normalize,
  normalizeTopics,
  slugOf,
  time,
} from "./units";
import { observationsNow, readPeople } from "./who";
import { dayStart, localDate } from "./zones";

// The read path, as `bun life memory search|person|area` (src/memory/command.ts): short cited results from the pages
// and derived/memory/index.sqlite. It also owns the index: buildIndex writes it, nothing else here writes.
//   search <words>   moments, observations and units matching the words, the exact spoken words (lifelog's search) and chats
//   day <date>       what happened that day (its moments), its recorded conversations and chapters, its units from the
//                    other sources and its key observations
//   person [name]    a person's page digest, latest observations, last moments with them and recorded conversations; with
//                    no name, the people
//   area <id>        an area's page digest and latest observations
//   topics [tag]     the top topics, or the units tagged so, by date (--person <id>: only units involving them)
//   unresolved       names Life could not map to truth/, most seen first

export const INDEX = join(OUT, "index.sqlite");
const LIMIT = 12;

/** A moment as the read path prints it: its id (to correct it), when, what, where, how it stands, with whom, and units to `fetch`. */
export const momentLine = (m: Moment) =>
  `- ${m.id} ${m.start ?? `${m.day} (undated)`}${m.end ? ` to ${m.end}` : ""} ${m.title}${m.place ? ` @ ${m.place}` : ""} (${m.status}${m.people.length > 0 ? `; ${m.people.map((p) => `${named({ speaker: p.ref })} ${p.role}`).join(", ")}` : ""}) [${m.units.slice(0, 3).join(" ")}]`;

/** The moments as they stand now that `keep` keeps, by when they happen. */
const momentsWhere = async (keep: (m: Moment) => boolean) => {
  const [lines, corrections] = await Promise.all([
    readMoments(),
    readCorrections(),
  ]);
  return momentsNow(lines, corrections)
    .filter(keep)
    .toSorted((a, b) => daysOf(a)[0].localeCompare(daysOf(b)[0]));
};
const DAY_FACTS = 15;
const VOICE_LIMIT = 20;
const VOICE_MAX = 600;
const QUOTE_MAX = 140;
const TITLE_MAX = 50;
const DIGEST = 2000;
const WORD = /[\p{L}\p{N}]+/gu;

interface Row {
  channel: string;
  confidence: number;
  date: string;
  id: string;
  people: string | null;
  quote: string;
  text: string;
  title: string | null;
  type: string;
  when: string | null;
}

/** An observation hit, with its date if it carries one, a doubt, and where it comes from: `(channel "unit title"; people ids)`. */
const line = (r: Row) => {
  const q = r.quote.replace(/\s+/g, " ");
  const from = `${r.channel} "${clip(r.title ?? "", TITLE_MAX)}"${r.people ? `; ${r.people}` : ""}`;
  const about = `${r.when ? ` (for ${r.when})` : ""}${r.confidence < SURE_AT ? " (unsure)" : ""}`;
  return `- ${r.id} ${r.date} ${r.type}: ${r.text}${about} "${q.length > QUOTE_MAX ? `${q.slice(0, QUOTE_MAX)}…` : q}" (${from})`;
};

interface UnitRow {
  date: string;
  id: string;
  source: string;
  title: string;
  topics: string;
}

const unitLine = (u: UnitRow) =>
  `- ${u.id} ${u.date} ${u.source}: ${clip(u.title, 80)}${u.topics ? ` [${u.topics}]` : ""}`;

const COLUMNS = `o.id, o.date, o.type, o.text, o.quote, o.channel, o.confidence, o."when",
  (select title from units where id = o.unit) as title,
  (select group_concat(replace(replace(person, 'person:', ''), 'unknown:', ''), ', ') from unit_people where unit = o.unit) as people`;
const CURRENT = "o.superseded_by is null";

/** Every word quoted, so FTS5 reads them as words, never as its query syntax. */
const ftsQuery = (q: string, op: "AND" | "OR") =>
  (q.match(WORD) ?? []).map((w) => `"${w}"`).join(` ${op} `);

export function matches(db: Database, q: string) {
  const sql = `select ${COLUMNS} from search s join observations o on o.id = s.id
    where search match ? and ${CURRENT} order by rank limit ${LIMIT}`;
  const unitSql = `select u.id, u.date, u.source, u.title, u.topics from unit_search s join units u on u.id = s.id
    where unit_search match ? order by rank limit ${LIMIT}`;
  const found = (query: string) => ({
    observations: db.query<Row, [string]>(sql).all(query).map(line),
    units: db.query<UnitRow, [string]>(unitSql).all(query).map(unitLine),
  });
  for (const mode of ["AND", "OR"] as const) {
    const query = ftsQuery(q, mode);
    const { observations, units } = query
      ? found(query)
      : { observations: [], units: [] };
    if (observations.length + units.length > 0) {
      return [
        ...observations,
        ...(units.length > 0
          ? ["", "Units (titles, summaries, topics):", ...units]
          : []),
      ];
    }
  }
  return ["(nothing found)"];
}

/** The page whose file is `name` (an id or a name's slug), else the first whose file name contains it. */
async function findPage(dir: "people" | "areas", name: string) {
  const slug = slugOf(name);
  const files = await readdir(join(PAGES, dir)).catch(() => [] as string[]);
  const file = files.includes(`${slug}.md`)
    ? `${slug}.md`
    : files.find((f) => f.includes(slug));
  return file
    ? {
        id: file.slice(0, -3),
        text: await Bun.file(join(PAGES, dir, file)).text(),
      }
    : null;
}

function latest(db: Database, where: string, value: string) {
  return db
    .query<Row, [string]>(
      `select ${COLUMNS} from observations o ${where} and o.salience >= ${KEEP_AT} and ${CURRENT}
       order by o.at desc limit ${LIMIT}`
    )
    .all(value)
    .map(line);
}

const NOT_BUILT =
  "Life's memory index isn't built yet (bun life memory index).";

/**
 * Reads the index read-only with `read`, or null when it isn't built. A rebuild meanwhile is safe (`buildIndex`); the
 * wait covers the moment it checkpoints its log into the file. `read` can't be async: the index closes when it returns.
 */
export function readIndex<T>(
  read: (db: Database) => T extends PromiseLike<unknown> ? never : T
): T | null {
  if (!existsSync(INDEX)) {
    return null;
  }
  const db = new Database(INDEX, { readonly: true });
  try {
    db.run("pragma busy_timeout = 5000");
    return read(db);
  } finally {
    db.close();
  }
}

/** `lines` from the index under the usual heading; says so when it isn't built. */
function withIndex(lines: (db: Database) => string[]) {
  const out = readIndex(lines);
  return out === null ? NOT_BUILT : asData(out);
}

/** A page's digest, when it has one, then the observations `rows` finds for it. */
function entity(text: string | null, rows: (meta?: PageMeta) => string[]) {
  const meta = text ? parsePage(text)?.meta : undefined;
  const found = rows(meta);
  return [
    ...(text && meta ? [`## ${meta.name}`, digestOf(text, DIGEST), ""] : []),
    "Latest observations:",
    ...(found.length > 0 ? found : ["(none)"]),
  ];
}

/** The voice section of `search`: lifelog's best passages for the words, each with its place in its conversation. */
async function voiceHits(words: string, range: { from?: string; to?: string }) {
  try {
    const hits = await searchVoice(words, range, VOICE_LIMIT);
    return withStore((store) =>
      hits.length > 0
        ? hits.map((h) => {
            const at = h.capturedFrom ? `${localTime(h.capturedFrom)}` : "?";
            const turn = turnOffset(
              store,
              h.conversationId,
              h.jobId,
              h.firstTurn
            );
            return `- ${h.conversationId} ${at} turn ${turn}: ${clip(redact(h.text.replace(/\s*\n\s*/g, " / ")), VOICE_MAX)}`;
          })
        : ["(nothing found)"]
    );
  } catch (e) {
    return [`(voice search unavailable: ${(e as Error).message})`];
  }
}

/** `from`/`to` bound the voice and chat sections only. */
export async function search(
  words: string,
  o: { from?: string; to?: string } = {}
) {
  const range = dayRange(o.from, o.to);
  // lifelog's search is a network call: the chats are read meanwhile.
  const holds = holdsAll(words);
  const [voice, chats, found] = await Promise.all([
    voiceHits(words, range),
    chatHits(words, range),
    momentsWhere((m) => holds(`${m.title} ${m.place ?? ""}`)),
  ]);
  return withIndex((db) => [
    ...(found.length > 0
      ? [
          "Moments (what happened or is planned):",
          ...found.slice(-LIMIT).map(momentLine),
          "",
          "Observations and units:",
        ]
      : []),
    ...matches(db, words),
    "",
    "Voice (exact spoken words; conversation id, time, turn: `fetch <id> --from-turn <turn>`):",
    ...voice,
    "",
    "Chats and notes (messages and note versions holding all the words, with the ones around them; each heading says where to read more):",
    ...chats,
  ]);
}

/** Who goes by this name (or id): the people on the map and the ones Life inferred, by name or alias. */
export function namedLike<
  T extends { aliases: string[]; id: string; name: string },
>(name: string, people: T[]) {
  return people.filter(
    (p) =>
      p.id === name ||
      [p.name, ...p.aliases].some((n) => normalize(n) === normalize(name))
  );
}

/** One line per person who goes by the name, with relation and observation count; only when more than one does. */
export function candidateLines(
  name: string,
  same: { id: string; name: string; relation?: string }[],
  count: (id: string) => number
) {
  return same.length < 2
    ? []
    : [
        `${same.length} people go by "${name}" (the first below; \`person <id>\` for another):`,
        ...same.map(
          (p) =>
            `- ${p.id}: ${p.name}, ${p.relation ?? "?"}, ${count(p.id)} observations`
        ),
        "",
      ];
}

/** The people who have a page: id and name. */
async function peoplePages() {
  const files = await readdir(join(PAGES, "people")).catch(
    () => [] as string[]
  );
  return Promise.all(
    files.map(async (f) => ({
      id: f.slice(0, -3),
      name:
        parsePage(await Bun.file(join(PAGES, "people", f)).text())?.meta.name ??
        f,
    }))
  );
}

/** Who has a page, the latest seen first (the date of the newest observation about them). */
function withPages(db: Database, list: { id: string; name: string }[]) {
  const seen = new Map(
    db
      .query<{ at: string; id: string }, []>(
        "select substr(l.entity, 8) as id, max(o.at) as at from links l join observations o on o.id = l.observation where l.entity like 'person:%' group by l.entity"
      )
      .all()
      .map((r) => [r.id, r.at])
  );
  return list
    .map((p) => ({ ...p, at: seen.get(p.id) }))
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .map(
      (p) =>
        `- ${p.id}: ${p.name}${p.at ? ` (last seen ${localDate(p.at)})` : ""}`
    );
}

/** A name two people go by lists them, then shows the first; a name on no page nor map is looked for among lifelog's speakers. */
export async function person(name?: string) {
  if (!name) {
    const list = await peoplePages();
    return withIndex((db) => {
      const pages = withPages(db, list);
      return pages.length > 0 ? pages : ["(no people pages yet)"];
    });
  }
  const { canon, inferred, refOf, truth } = await readPeople();
  const same = namedLike(name, [
    ...truth.people,
    ...new Map(
      inferred
        .filter((p) => canon(`person:${p.id}`) === `person:${p.id}`)
        .map((p) => [p.id, { ...p, aliases: p.surfaces }])
    ).values(),
  ]);
  const found = await findPage("people", same[0]?.id ?? name);
  const id = found?.id ?? same[0]?.id ?? slugOf(name);
  const mapped = truth.people.find((p) => p.id === id);
  const shared = (
    await momentsWhere((m) =>
      m.people.some(({ ref }) => refOf(ref) === `person:${id}`)
    )
  ).slice(-LIMIT);
  const sharedLines =
    shared.length > 0
      ? ["", "Last moments with them:", ...shared.map(momentLine)]
      : [];
  return withStore((store) =>
    withIndex((db) => {
      const heard =
        found || same.length > 0
          ? []
          : speakers(store).filter((s) =>
              normalize(s.name).includes(normalize(name))
            );
      const lifelog = mapped?.handles.lifelog;
      const ids = lifelog ? [lifelog] : heard.map((s) => s.id);
      return [
        ...candidateLines(
          name,
          same,
          (who) =>
            db
              .query<{ n: number }, [string]>(
                `select count(*) as n from links l join observations o on o.id = l.observation where l.entity = ? and ${CURRENT}`
              )
              .get(`person:${who}`)?.n ?? 0
        ),
        // The owner's own page opens with his goals, in his words and his order.
        ...(`person:${id}` === OWNER && truth.me.goals
          ? ["Goals (truth/me.md, his words):", truth.me.goals, ""]
          : []),
        ...entity(found?.text ?? null, () =>
          latest(
            db,
            "join links l on l.observation = o.id where l.entity = ?",
            `person:${id}`
          )
        ),
        ...sharedLines,
        ...(ids.length > 0
          ? [
              "",
              `Recorded conversations${heard.length > 0 ? ` with lifelog speakers named ${[...new Set(heard.map((s) => s.name))].join(", ")}` : ""} (\`fetch <id>\`):`,
              ...conversationsWith(store, ids, LIMIT).map(
                (c) =>
                  `- ${c.id} ${localTime(c.start_at)}: ${clip(c.title, 80)}`
              ),
            ]
          : []),
      ];
    })
  );
}

const SUMMARY = 200;

/**
 * The lines of `day`: what happened (its moments, planned ones included), the day's conversations with their chapters,
 * its chat and mail units, its key observations, then what Life changed for him.
 */
export function dayLines(
  conversations: LifelogConversation[],
  units: UnitRow[],
  facts: string[] = [],
  actions: Action[] = [],
  moments: Moment[] = []
) {
  return [
    ...(moments.length > 0
      ? ["What happened (moments):", ...moments.map(momentLine), ""]
      : []),
    `Recorded conversations (${conversations.length}; \`fetch <id>\`):`,
    ...conversations.flatMap((c) => [
      `- ${c.id} ${time(c.startedAt)}–${time(c.endedAt)} ${clip(c.title, 80)}`,
      ...c.chapters.map(
        (h) =>
          `    ${time(h.start)} ${clip(h.title, 60)}${h.people.length > 0 ? ` (${h.people.join(", ")})` : ""}: ${clip(redact(h.summary), SUMMARY)}`
      ),
    ]),
    "",
    `Chat and mail units (${units.length}; \`fetch <unit id>\`):`,
    ...units.map(unitLine),
    ...(facts.length > 0 ? ["", "Key observations:", ...facts] : []),
    ...(actions.length > 0
      ? [
          "",
          "Actions (what Life changed, and why):",
          ...actions.map(
            (a) => `- ${time(a.at)} ${a.kind}: ${actionLine(a)} (${a.why})`
          ),
        ]
      : []),
  ];
}

export async function day(date: string) {
  const names = lifelogNames(await loadTruth());
  const actions = (await readActions()).filter((a) => localDate(a.at) === date);
  const moments = await momentsWhere((m) => {
    const [first, last] = daysOf(m);
    return first <= date && date <= last;
  });
  return withStore((store) =>
    withIndex((db) =>
      dayLines(
        readConversations(store, dayStart(date), names).filter(
          (c) => localDate(c.startedAt) === date
        ),
        db
          .query<UnitRow, [string]>(
            "select id, date, source, title, topics from units where date = ? and source <> 'lifelog' order by source, title"
          )
          .all(date),
        db
          .query<Row, [string]>(
            `select ${COLUMNS} from observations o where o.date = ? and o.salience >= ${KEEP_AT} and ${CURRENT}
             order by o.salience desc, o.at limit ${DAY_FACTS}`
          )
          .all(date)
          .map(line),
        actions,
        moments
      )
    )
  );
}

/** `bun life memory area <id or name>`: an area's page digest and latest observations. */
export async function area(name: string) {
  const text = (await findPage("areas", name))?.text ?? null;
  return withIndex((db) =>
    entity(text, (meta) =>
      meta?.page.startsWith("area:")
        ? latest(db, "where o.area = ?", meta.page.slice("area:".length))
        : []
    )
  );
}

/**
 * `bun life memory topics [tag] [--person <id>]`: with no tag, the top topics and how many units carry each; with a tag,
 * the units tagged so, by date. `person` keeps the units that involve that person.
 */
export const topicsOf = (tag: string | undefined, who?: string) =>
  withIndex((db) => {
    const involving = who
      ? " and u.id in (select unit from unit_people where person = ?)"
      : "";
    const args = who ? [`person:${who}`] : [];
    if (!tag) {
      const rows = db
        .query<{ n: number; topic: string }, string[]>(
          `select t.topic, count(*) as n from unit_topics t join units u on u.id = t.unit
           where 1 = 1${involving} group by t.topic order by n desc, t.topic limit 40`
        )
        .all(...args);
      return rows.length > 0
        ? rows.map((r) => `- ${r.topic}: ${r.n}`)
        : ["(no topics yet: run moments)"];
    }
    const wanted = normalizeTopics([tag])[0] ?? tag;
    const rows = db
      .query<UnitRow & { salience: number; type: string }, string[]>(
        `select u.id, u.date, u.source, u.title, u.topics, u.salience, u.type from units u
         join unit_topics t on t.unit = u.id where t.topic = ?${involving} order by u.date, u.id`
      )
      .all(wanted, ...args);
    return [
      `${rows.length} units tagged "${wanted}"${who ? ` involving ${who}` : ""}:`,
      ...rows.map((r) => `${unitLine(r)} (${r.type}, salience ${r.salience})`),
    ];
  });

const EXAMPLE_MAX = 80;

/**
 * `bun life memory unresolved`: for Claude. The people Life inferred (who it thinks they are, how sure, and how many
 * observations are about them), then the names it still cannot place, most seen first, with the days they appeared
 * on and an example unit. Nothing here waits on the owner; when he says who someone is, Claude records it with
 * `bun life memory correct`.
 */
export async function unresolved(top = 25) {
  const [rows, units, people] = await Promise.all([
    readUnresolved(),
    readUnits(),
    readPeople(),
  ]);
  const { inferred, resolve } = people;
  const byId = new Map(units.map((u) => [u.id, u]));
  const open = rows.filter((r) => !resolve(r.surface));
  const resolved = rows.length - open.length;
  const names = Map.groupBy(open, (r) => normalize(r.surface));
  const lines = [...names.values()]
    .sort((a, b) => b.length - a.length)
    .slice(0, top)
    .map((list) => {
      // The latest sighting whose unit still exists.
      const last = (
        list.some((r) => byId.has(r.unit))
          ? list.filter((r) => byId.has(r.unit))
          : list
      ).reduce((m, r) => (r.date > m.date ? r : m));
      const u = byId.get(last.unit);
      const surfaces = [...new Set(list.map((r) => r.surface))].join(" / ");
      const example = u
        ? `${u.date} ${u.source} "${clip(u.title, EXAMPLE_MAX)}" ${u.id}`
        : `${last.date} ${last.unit}`;
      return `- ${surfaces}: ${list.length} times, ${new Set(list.map((r) => r.date)).size} days, ${["model", "speaker"].map((v) => `${list.filter((r) => r.via === v).length} ${v}`).join(" / ")}. e.g. ${example}`;
    });
  const { observations } = await observationsNow(people);
  const about = new Map<string, number>();
  for (const o of observations) {
    for (const e of o.entities) {
      about.set(e, (about.get(e) ?? 0) + 1);
    }
  }
  const guesses = [...new Map(inferred.map((p) => [p.id, p])).values()]
    .sort((a, b) => b.confidence - a.confidence)
    .map(
      (p) =>
        `- person:${p.id} (${p.confidence}${p.confidence < INFERRED_USE_AT ? ", not used" : ""}): ${p.name}, ${p.relation}${p.area ? `, ${p.area}` : ""}. ${p.surfaces.join(" / ")}; ${p.evidence.length} quotes, ${about.get(`person:${p.id}`) ?? 0} observations`
    );
  return [
    `People Life inferred (${guesses.length}; used from confidence ${INFERRED_USE_AT}, below truth/ and your corrections):`,
    ...(guesses.length > 0 ? guesses : ["(none)"]),
    "",
    `Names not placed (${names.size}; ${resolved} sightings of names that now resolve are left out). Top ${Math.min(top, names.size)}:`,
    ...lines,
  ].join("\n");
}

const FTS = "tokenize = 'unicode61 remove_diacritics 2'";
const INDEX_SCHEMA = `
create table observations (
  id text primary key, unit text, date text, at text, type text, area text, salience integer, confidence real,
  speaker text, channel text, ref text, text text, quote text, valid_from text, valid_to text, "when" text,
  superseded_by text);
create virtual table search using fts5(id unindexed, text, quote, ${FTS});
create table links (observation text, entity text, primary key (observation, entity));
create index links_entity on links (entity);
create table units (
  id text primary key, date text, source text, title text, salience integer, type text, area text, topics text);
create virtual table unit_search using fts5(id unindexed, title, summary, topics, ${FTS});
create table unit_topics (unit text, topic text, primary key (unit, topic));
create table unit_people (unit text, person text, primary key (unit, person));
create index unit_topics_topic on unit_topics (topic);`;

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

/**
 * derived/memory/index.sqlite, rebuilt from scratch: observations (with the observation that replaced each retired
 * one, and its end date), full-text search over claims and quotes, links; and the units (titles, lifelog summaries and
 * the topics of their verdicts), so today's material is searchable before the nightly pass. Rebuilt in place, in one
 * write-ahead-log transaction, so a reader holding the file keeps the old index until the commit and sees the new one
 * after it; a rebuild waits for another to commit.
 */
export function buildIndex(
  observations: Observation[],
  path: string,
  standing: Standing,
  units: IndexedUnit[] = []
) {
  const db = new Database(path);
  db.run("pragma busy_timeout = 30000");
  db.run("pragma journal_mode = wal");
  const unique = new Map(observations.map((o) => [o.id, o]));
  const rebuild = db.transaction(() => {
    // Every table the file holds, whatever schema built it (a virtual table takes its shadow tables along).
    const tables = db
      .query<[string], []>(
        "select name from pragma_table_list where schema = 'main' and type in ('table', 'virtual') and name not like 'sqlite_%'"
      )
      .values();
    db.run(tables.map(([t]) => `drop table "${t}";`).join("") + INDEX_SCHEMA);
    // `insert or ignore` into a table of `n` columns.
    const insert = (table: string, n: number) =>
      db.prepare(
        `insert or ignore into ${table} values (${new Array(n).fill("?").join(", ")})`
      );
    const row = insert("observations", 17);
    const text = insert("search", 3);
    const link = insert("links", 2);
    const unitRow = insert("units", 8);
    const unitText = insert("unit_search", 4);
    const unitTopic = insert("unit_topics", 2);
    const unitPerson = insert("unit_people", 2);
    for (const o of unique.values()) {
      const retired = retirement(o, standing);
      row.run(
        o.id,
        o.unit,
        o.date,
        o.at,
        o.type,
        o.area,
        o.salience,
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
      for (const e of o.entities) {
        link.run(o.id, e);
      }
    }
    for (const { unit: u, verdict: v } of units) {
      const tags = v?.topics ?? [];
      unitRow.run(
        u.id,
        u.date,
        u.source,
        u.title,
        v?.salience ?? null,
        v?.type ?? null,
        v?.area ?? null,
        tags.join(", ")
      );
      unitText.run(u.id, u.title, u.summary ?? "", tags.join(" "));
      for (const t of tags) {
        unitTopic.run(u.id, t);
      }
      for (const p of u.people) {
        unitPerson.run(u.id, p);
      }
    }
  });
  try {
    rebuild.immediate();
  } finally {
    // `true`: every statement is finalized first, so the file is let go (and its log checkpointed) at once.
    db.close(true);
  }
  return unique.size;
}

/** Rebuilds the index from the ledger and the units; what the owner said is wrong or unimportant is not searchable. */
export async function reindex() {
  const [people, verdicts] = await Promise.all([readPeople(), readVerdicts()]);
  const units = (await readUnits()).map((unit) => ({
    unit,
    verdict: verdictOf(verdicts, unit),
  }));
  const { observations, standing } = await observationsNow(people);
  const n = buildIndex(observations, INDEX, standing, units);
  console.log(
    `${n} observations and ${units.length} units indexed in ${INDEX}`
  );
}
