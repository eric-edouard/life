import { Database } from "bun:sqlite";
import { clock } from "../core/clock";
import { CANDIDATES } from "../core/embedder";
import { newestIn } from "../core/files";
import { fuse } from "../core/fusion";
import { type Call, isReviewCall, recentEvents } from "../core/log";
import type { SourceName } from "../core/names";
import { redact } from "../core/redact";
import { openReadOnly } from "../core/sqlite";
import type { Episode } from "../records/episode";
import { isListed, type LedgerEntry } from "../records/ledger-entry";
import {
  type Detail,
  INFERRED_USE_AT,
  Level,
  type Observation,
} from "../records/observation";
import type { Unit, Verdict } from "../records/unit";
import { KEEP_AT } from "../records/unit";
import { type Contact, readContactRecords } from "../sources/contacts";
import {
  conversationsWith,
  lifelogMissing,
  searchVoice,
  speakers,
  turnPlace,
  withStore,
} from "../sources/lifelog";
import {
  AGAIN_DAYS,
  type Candidate,
  entryLine,
  OVERDUE_DAYS,
  openItems,
  openLinked,
} from "../todo-list/items";
import { levelsWith, pagedNow } from "./closeness";
import {
  communicationStyleBlock,
  readCommunicationStyle,
} from "./communication-style";
import {
  BIRTHDAY_DAYS,
  birthdayIn,
  birthdaysNear,
  type DetailFact,
  detailOf,
  detailsBlock,
  detailsOf,
  readDetailTags,
} from "./details";
import { span } from "./episode-span";
import {
  daysOf,
  episodesNow,
  INDEX,
  MEMORY,
  pagePath,
  readBy,
  readCorrections,
  readEpisodes,
  readIndex,
  readLedger,
  readUnits,
  readUnresolved,
  readVerdicts,
  type Standing,
  stateOf,
  type Verdicts,
  verdictOf,
  writtenPeople,
} from "./ledger";
import { SURE_AT } from "./observe";
import {
  bodyOf,
  generated,
  parsePage,
  placed,
  renderLine,
} from "./page-format";
import { stayOf, staysOf, where } from "./places";
import {
  goalProjects,
  loadTruth,
  OWNER,
  TRUTH,
  type Truth,
} from "./read-truth";
import { readSituationNow, situated, situationBlock } from "./situation";
import { kindOf, listening } from "./sources";
import { episodeText } from "./statements";
import {
  clip,
  dayRange,
  daysBefore,
  localTime,
  newestDays,
  normalize,
  normalizeTopics,
  PERSON,
  slugOf,
  time,
} from "./units";
import { embedQuery, readNearest, type Searched } from "./vectors";
import {
  meant,
  who as named,
  namedLike,
  nearNames,
  observationsNow,
  type People,
  readPeople,
  unitNow,
} from "./who";
import {
  asData,
  chatHits,
  focus,
  holdsAll,
  MAIL_HITS,
  mailHits,
  readChatTexts,
  repliesOwed,
} from "./words";
import { dayNow, dayStart, localDate } from "./zones";

// The read path, as `bun life memory search|person|area` (apps/server/src/host/command.ts): short cited results from the pages
// and derived/memory/index.sqlite. It also owns the index: buildIndex writes it, nothing else here writes.
//   search <words>   episodes, observations and units matching the words, the exact spoken words (lifelog's search) and chats
//   day <date>       what happened that day (its episodes), its units (recorded conversations among them) and its key
//                    observations
//   person [name]    a person's page, what Life holds about them, their observations, episodes and recorded conversations,
//                    paged back by day; with no name, the people
//   area <id>        an area's page and latest observations
//   topics [tag]     the top topics, or the units tagged so, by date (--person <id>: only units involving them)
//   unresolved       names Life could not map to truth/, most seen first

const LIMIT = 12;
/** A section's first LIMIT lines (its last, `newest`), saying so when there were more. */
const cut = (lines: string[], newest = false) =>
  lines.length > LIMIT
    ? [
        ...(newest ? lines.slice(-LIMIT) : lines.slice(0, LIMIT)),
        `(cut at ${LIMIT}: narrow with \`from\` and \`to\`)`,
      ]
    : lines;

/** An episode's text, each person by their ref: what the read path prints and both rankings read. */
const episodeTextNow = (m: Episode) =>
  episodeText(m, (ref) => named({ speaker: ref }));

/** An episode as the read path prints it: its id (to correct it), `episodeText`, and units to `fetch`. */
export const episodeLine = (m: Episode) =>
  `- ${m.id} ${episodeTextNow(m)}${m.start ? "" : ` (${m.day}, undated)`} [${m.units.slice(0, 3).join(" ")}]`;

/** The episodes as they stand now that `keep` keeps, by when they happen. */
// ponytail: every episode line is read (≈25 MB at 10 years): `person` and `day` need them all (a person's history,
// `readBy`); index the episodes if a read of them shows up.
const episodesWhere = async (keep: (m: Episode) => boolean) => {
  const [lines, corrections] = await Promise.all([
    readEpisodes(),
    readCorrections(),
  ]);
  return episodesNow(lines, corrections)
    .filter(keep)
    .toSorted((a, b) => daysOf(a)[0].localeCompare(daysOf(b)[0]));
};
const DAY_FACTS = 15;
const VOICE_LIMIT = 20;
const VOICE_MAX = 300;
const QUOTE_MAX = 140;
const TITLE_MAX = 50;
const WORD = /[\p{L}\p{N}]+/gu;

interface Row {
  channel: SourceName;
  confidence: number;
  date: string;
  id: string;
  people: string | null;
  quote: string;
  speaker: string | null;
  text: string;
  title: string | null;
  type: string;
  when: string | null;
}

/** Who said it, when not him: "by" a sender (exact), "heard as" a voice (lifelog names one wrongly about 5% of the time). Labelled, never filtered. */
const byOf = ({ channel, speaker }: Row) =>
  !speaker || speaker === OWNER
    ? ""
    : ` ${kindOf(channel) === "voice" ? "heard as" : "by"} ${named({ speaker })}`;

/** An observation hit, with its date if it carries one, who said it when not him, a doubt, and where it comes from: `(channel "unit title"; people ids)`. */
const line = (r: Row) => {
  const q = r.quote.replace(/\s+/g, " ");
  const from = `${r.channel} "${clip(r.title ?? "", TITLE_MAX)}"${r.people ? `; ${r.people}` : ""}`;
  const about = `${r.when ? ` (for ${r.when})` : ""}${byOf(r)}${r.confidence < SURE_AT ? " (unsure)" : ""}`;
  return `- ${r.id} ${r.date} ${r.type}: ${r.text}${about} "${q.length > QUOTE_MAX ? `${q.slice(0, QUOTE_MAX)}…` : q}" (${from})`;
};

interface UnitRow {
  date: string;
  id: string;
  /** Its verdict's, or null when it has none yet. */
  importance?: number | null;
  source: SourceName;
  title: string;
  topics: string;
}

const unitLine = (u: UnitRow) =>
  `- ${u.id} ${u.date} ${u.source}: ${clip(u.title, 80)}${u.topics ? ` [${u.topics}]` : ""}`;

const COLUMNS = `o.id, o.date, o.type, o.text, o.quote, o.channel, o.confidence, o."when", o.speaker,
  (select title from units where id = o.unit) as title,
  (select group_concat(replace(replace(person, 'person:', ''), 'unknown:', ''), ', ') from unit_people where unit = o.unit) as people`;
const CURRENT = "o.superseded_by is null";

/** Every word quoted, so FTS5 reads them as words, never as its query syntax. */
const ftsQuery = (q: string, op: "AND" | "OR") =>
  (q.match(WORD) ?? []).map((w) => `"${w}"`).join(` ${op} `);

interface Days {
  from?: string;
  to?: string;
}
/** The local days `from` to `to` (both included, either open) as a SQL condition on `col`, with its values. */
const between = (col: string, r: Days) => ({
  args: [r.from, r.to]
    .filter((d): d is string => !!d)
    .map((d) => d.slice(0, 10)),
  sql: `${r.from ? ` and ${col} >= ?` : ""}${r.to ? ` and ${col} <= ?` : ""}`,
});
/** Days `first` to `last` reach inside `r`. */
const daysMeet = (r: Days, first: string, last = first) =>
  (!r.from || last >= r.from.slice(0, 10)) &&
  (!r.to || first <= r.to.slice(0, 10));
/** An episode that has a day inside `r`. */
const inDays = (r: Days) => (m: Episode) => daysMeet(r, ...daysOf(m));

/** An observation's and a unit's text, as both rankings read them (`unit_search` holds a unit's). */
const OBSERVATION_TEXT = "o.text || char(10) || o.quote";
const UNIT_TEXT =
  "coalesce(s.title, '') || char(10) || coalesce(s.summary, '') || char(10) || coalesce(s.topics, '')";

/** Rows of `sql` (taking the ids as JSON) for `ids`, in their order. */
function rowsFor<R extends { id: string }>(
  db: Database,
  sql: string,
  ids: string[]
) {
  const byId = new Map(
    db
      .query<R, [string]>(sql)
      .all(JSON.stringify(ids))
      .map((r) => [r.id, r])
  );
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** The observations and units best for `q` by meaning (`vector`) and by words (holding them all), fused (`fuse`). */
export function matches(
  db: Database,
  q: string,
  range: Days = {},
  vector?: number[]
) {
  const o = between("o.date", range);
  const u = between("u.date", range);
  const query = ftsQuery(q, "AND");
  const held = (sql: string, args: string[]) =>
    query
      ? db
          .query<{ id: string }, string[]>(sql)
          .all(query, ...args)
          .map((r) => r.id)
      : [];
  const best = (rankings: string[][]) =>
    fuse(rankings)
      .slice(0, LIMIT + 1)
      .map(([id]) => id);
  const texts = (sql: string, args: string[]) => () =>
    db.query<{ id: string; text: string }, string[]>(sql).all(...args);
  const observations = rowsFor<Row>(
    db,
    `select ${COLUMNS} from observations o where o.id in (select value from json_each(?))`,
    best([
      readNearest(
        vector,
        texts(
          `select o.id, ${OBSERVATION_TEXT} as text from observations o where ${CURRENT}${o.sql}`,
          o.args
        )
      ),
      held(
        `select o.id from search s join observations o on o.id = s.id
          where search match ? and ${CURRENT}${o.sql} order by rank limit ${CANDIDATES}`,
        o.args
      ),
    ])
  ).map(line);
  const units = rowsFor<UnitRow>(
    db,
    "select id, date, source, title, topics from units where id in (select value from json_each(?))",
    best([
      readNearest(
        vector,
        texts(
          `select s.id, ${UNIT_TEXT} as text from unit_search s join units u on u.id = s.id where 1${u.sql}`,
          u.args
        )
      ),
      held(
        `select u.id from unit_search s join units u on u.id = s.id
          where unit_search match ?${u.sql} order by rank limit ${CANDIDATES}`,
        u.args
      ),
    ])
  ).map(unitLine);
  if (observations.length + units.length === 0) {
    return ["(nothing found)"];
  }
  return [
    ...cut(observations),
    ...(units.length > 0
      ? ["", "Units (titles, summaries, topics):", ...cut(units)]
      : []),
  ];
}

/** The observations `clause` finds worth a page line, newest first: `limit` of them (-1: all). */
function latest(db: Database, clause: string, value: string, limit = LIMIT) {
  return db
    .query<Row, [string]>(
      `select ${COLUMNS} from observations o ${clause} and o.importance >= ${KEEP_AT} and ${CURRENT}
       order by o.date desc, o.at desc limit ${limit}`
    )
    .all(value);
}

const NOT_BUILT =
  "Life's memory index isn't built yet (bun life memory index).";

/** `lines` from the index under the usual heading; says so when it isn't built. */
function withIndex(lines: (db: Database) => string[]) {
  const out = readIndex(lines);
  return out === null ? NOT_BUILT : asData(out);
}

/** The page's text, each Between us line followed by the days of its first and latest evidence. */
export function withSpans(text: string, dateOf: (id: string) => string[]) {
  const parsed = parsePage(text);
  let body = bodyOf(text);
  for (const l of parsed ? generated(parsed).bond : []) {
    const days = l.cites.flatMap(dateOf).toSorted();
    const rendered = renderLine("bond", l);
    // A function, so a `$` in the line is never read as a replacement pattern.
    body = body.replace(rendered, () =>
      days.length > 0
        ? `${rendered} (since ${days[0]} · last evidence ${days.at(-1)})`
        : rendered
    );
  }
  return body;
}

/** A page, whole, with when it was built, when it has one; then the observations found for it. */
function entity(db: Database, text: string | null, found: string[]) {
  const meta = text ? parsePage(text)?.meta : undefined;
  const dates = db.query<{ date: string }, [string]>(
    "select date from observations where id = ?"
  );
  return [
    ...(text && meta
      ? [
          `(page built ${meta.built.slice(0, 16).replace("T", " ")} UTC: newer observations are below, not on it yet)`,
          redact(withSpans(text, (id) => dates.all(id).map((r) => r.date))),
          "",
        ]
      : []),
    "Latest observations:",
    ...(found.length > 0 ? found : ["(none)"]),
  ];
}

/** The voice section of `search`: lifelog's best passages for the words, each with its place in its conversation. */
async function voiceHits(words: string, range: { from?: string; to?: string }) {
  if (!listening()) {
    return ["(no voice source)"];
  }
  try {
    const hits = await searchVoice(words, range, VOICE_LIMIT);
    return withStore((store) =>
      hits.length > 0
        ? hits.map((h) => {
            const at = h.capturedFrom ? `${localTime(h.capturedFrom)}` : "?";
            const p = turnPlace(store, h.jobId, h.firstTurn);
            return `- ${p?.conversation ?? h.conversationId} ${at} turn ${p?.offset ?? 0}: ${focus(redact(h.text), words, VOICE_MAX).replace(/\s*\n\s*/g, " / ")}`;
          })
        : ["(nothing found)"]
    );
  } catch (e) {
    return [`(voice search unavailable: ${(e as Error).message})`];
  }
}

/** `from`/`to` (local days, both included) bound every section. Each ranks by meaning and by words, fused (`fuse`). */
export async function search(words: string, o: Days = {}) {
  const range = dayRange(o.from, o.to);
  const { note, vector } = await embedQuery(words);
  // lifelog's search is a network call: the chats are read meanwhile.
  const holds = holdsAll(words);
  const [voice, chats, mail, all] = await Promise.all([
    voiceHits(words, range),
    chatHits(words, range, undefined, vector),
    mailHits(words, range, undefined, vector),
    episodesWhere(() => true),
  ]);
  const inside = all.filter(inDays(o));
  const ranked = fuse([
    readNearest(vector, () =>
      inside.map((m) => ({ id: m.id, text: episodeTextNow(m) }))
    ),
    inside
      .filter((m) => holds(episodeTextNow(m)))
      .toReversed()
      .map((m) => m.id),
  ]).map(([id]) => id);
  const top = new Set(ranked.slice(0, LIMIT));
  const found = inside.filter((m) => top.has(m.id));
  const situations = await readSituationsOf(
    words,
    new Set(all.map((m) => m.id)),
    new Set(found.map((m) => m.id)),
    !(o.from || o.to)
  );
  return withIndex((db) => [
    ...(note ? [note, ""] : []),
    ...situations,
    ...(found.length > 0
      ? [
          "Episodes (what happened):",
          ...found.map(episodeLine),
          ...(ranked.length > LIMIT
            ? [`(the best ${LIMIT}: narrow with \`from\` and \`to\`)`]
            : []),
          "",
        ]
      : []),
    ...(found.length > 0 ? ["Observations and units:"] : []),
    ...matches(db, words, o, vector),
    "",
    `Voice (exact spoken words, the best ${VOICE_LIMIT}: narrow with \`from\`/\`to\` for others; conversation id, time, turn: \`fetch <id> --from-turn <turn>\`):`,
    ...voice,
    "",
    "Chats and notes (the best passages: a chat's messages close in time, or a note's version; each heading says where to read more):",
    ...chats,
    "",
    `Mail (no newsletters: the best ${MAIL_HITS} thread-days; each its unit, \`fetch <unit>\` for the thread):`,
    ...mail,
  ]);
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
  return Promise.all(
    (await writtenPeople()).map(async (ref) => {
      const id = ref.slice("person:".length);
      const page = parsePage(await Bun.file(pagePath(ref)).text());
      return { id, name: page?.meta.name ?? id };
    })
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

/** One thing of a person's timeline: its day, which list it shows in, and its line. */
interface Dated {
  day: string;
  kind: "conversation" | "episode" | "observation";
  line: string;
}

const total = (rows: { n: number }[]) => rows.reduce((a, r) => a + r.n, 0);

/**
 * What Life holds about someone, by source and by month, and what it can't hold, so a short answer never reads as
 * "nothing happened". `timeline`: everything the person's answer pages through.
 */
export function coverageLines(db: Database, ref: string, timeline: Dated[]) {
  const start = db
    .query<{ d: string | null }, []>("select min(date) as d from units")
    .get()?.d;
  const units = db
    .query<
      { first: string; last: string; m: string; n: number; source: string },
      [string]
    >(
      `select substr(u.date, 1, 7) as m, u.source, count(*) as n, min(u.date) as first, max(u.date) as last
       from unit_people p join units u on u.id = p.unit where p.person = ? group by m, u.source`
    )
    .all(ref);
  const sources = [...Map.groupBy(units, (u) => u.source)].sort(
    (a, b) => total(b[1]) - total(a[1])
  );
  const monthOf = (d: string) => d.slice(0, 7);
  const byMonth = Map.groupBy(units, (u) => u.m);
  const dated = Map.groupBy(timeline, (t) => monthOf(t.day));
  const months = [...new Set([...byMonth.keys(), ...dated.keys()])].sort();
  const count = (m: string, kind: Dated["kind"]) =>
    (dated.get(m) ?? []).filter((t) => t.kind === kind).length;
  return [
    `What Life holds about them (its memory starts on ${start ?? "?"}; older chats are only in the archive: \`chats\` with \`who\` and \`from\`):`,
    ...sources.map(
      ([s, rows]) =>
        `- ${s}: ${total(rows)} units, ${rows.map((r) => r.first).sort()[0]} to ${rows
          .map((r) => r.last)
          .sort()
          .at(-1)}`
    ),
    "By month:",
    ...months.map((m) => {
      const here = (byMonth.get(m) ?? []).toSorted((a, b) => b.n - a.n);
      const by = here.map((r) => `${r.source} ${r.n}`).join(", ");
      return `- ${m}: ${total(here)} units${by ? ` (${by})` : ""}, ${count(m, "observation")} observations, ${count(m, "episode")} episodes`;
    }),
    "Not in Life: calls, and time together that wasn't recorded.",
  ];
}

/**
 * A person: their page, whole, and what Life holds about them by source and month; then their observations (every
 * one linked to them, whatever page it lives on) and the episodes with them, newest first by whole days, and their
 * recorded conversations. `before` (a day, exclusive) pages back; each answer names the next one. A name
 * two people go by lists them, then shows the first; a name on no page nor map is looked for among lifelog's
 * speakers; a name no one goes by says so and lists the names near it.
 */
export async function person(name?: string, o: { before?: string } = {}) {
  if (!name) {
    const list = await peoplePages();
    return withIndex((db) => {
      const pages = withPages(db, list);
      return pages.length > 0 ? pages : ["(no people pages yet)"];
    });
  }
  const folks = await readPeople();
  const { refOf, truth } = folks;
  const { all: people, known, same } = meant(name, folks);
  // The person's own page, by its id: never one whose file name only holds the name.
  const file = known && Bun.file(pagePath(`person:${known}`));
  const found =
    file && (await file.exists()) ? { text: await file.text() } : null;
  const id = known ?? slugOf(name);
  const ref = `person:${id}`;
  const mapped = truth.people.find((p) => p.id === id);
  const lifelog = mapped?.handles.lifelog;
  const details = detailsBlock(readDetailsOf(folks)(ref), dayNow());
  const close = closenessLine(ref, folks);
  // Pages go by whole local days: a day is never cut between two answers.
  const before = o.before?.slice(0, 10);
  const all = await episodesWhere(() => true);
  const live = new Set(all.map((m) => m.id));
  const episodes = all.filter((m) =>
    m.people.some((p) => refOf(p.ref) === ref)
  );
  return withStore((store) =>
    withIndex((db) => {
      // A name on no page nor map: the lifelog speakers it is part of.
      const voices = speakers(store);
      const heard = known
        ? []
        : voices.filter((s) => normalize(s.name).includes(normalize(name)));
      if (!(known || heard.length > 0)) {
        return noOne(name, people, voices);
      }
      const ids = lifelog ? [lifelog] : heard.map((s) => s.id);
      // One timeline, newest first, paged once: observations, episodes and recorded conversations.
      const timeline: Dated[] = [
        ...latest(
          db,
          "join links l on l.observation = o.id where l.entity = ?",
          ref,
          -1
        ).map((r) => ({
          day: r.date,
          kind: "observation" as const,
          line: line(r),
        })),
        ...episodes.toReversed().map((m) => ({
          day: daysOf(m)[0],
          kind: "episode" as const,
          line: episodeLine(m),
        })),
        ...conversationsWith(store, ids).map((c) => ({
          day: localDate(c.start_at),
          kind: "conversation" as const,
          line: `- ${c.id} ${localTime(c.start_at)}: ${clip(c.title, 80)}`,
        })),
      ].toSorted((a, b) => b.day.localeCompare(a.day));
      const { next, taken } = newestDays(
        timeline,
        (t) => t.day,
        PAGE_ITEMS,
        before
      );
      const lines = (kind: Dated["kind"]) =>
        taken.filter((t) => t.kind === kind).map((t) => t.line);
      const obsLines = lines("observation");
      return [
        ...candidateLines(name, same, (who) => linkedCount(db, who)),
        ...(before
          ? [`Before ${before}:`, "Observations:", ...orNone(obsLines)]
          : [
              ...details,
              ...close,
              ...situationBlock("Situation", readSituationNow(ref, live)),
              ...communicationStyleBlock(
                "Communication style",
                readCommunicationStyle(ref)
              ),
              ...entity(db, found?.text ?? null, obsLines),
              "",
              ...coverageLines(db, ref, timeline),
            ]),
        ...section("Episodes with them:", lines("episode")),
        ...section(recordedTitle(heard), lines("conversation")),
        "",
        next
          ? `Older: the same call with \`before\` ${next}.`
          : "(nothing older)",
      ];
    })
  );
}

/** `heard`: the lifelog speakers a name on no page nor map was found among. */
const recordedTitle = (heard: { name: string }[]) =>
  `Recorded conversations${heard.length > 0 ? ` with lifelog speakers named ${[...new Set(heard.map((s) => s.name))].join(", ")}` : ""} (\`fetch <id>\`):`;

/** How many things of a person's timeline an answer shows, its last day taken whole. */
const PAGE_ITEMS = 24;
const SPACES = /\s+/;

/**
 * The situations a search opens with, so its hits are read knowing where things stand: whole, those of the people
 * `words` name (him aside), else his own when the search is about now (`isNow`: no days bound it); then, from every
 * other situation, the lines citing an episode the search shows (`shown`). `live`: the episodes there are.
 */
export async function readSituationsOf(
  words: string,
  live: ReadonlySet<string>,
  shown: ReadonlySet<string>,
  isNow: boolean
) {
  const { names, nameOf, truth } = await readPeople();
  const said = ` ${normalize(words).split(SPACES).join(" ")} `;
  const aliases = (ref: string) =>
    truth.people.find((p) => `person:${p.id}` === ref)?.aliases ?? [];
  const refs = await situated();
  const mentioned = refs.filter(
    (ref) =>
      ref !== OWNER &&
      [names.get(ref), ...aliases(ref)].some(
        (n) => n && said.includes(` ${normalize(n)} `)
      )
  );
  const whole = mentioned.length > 0 || !isNow ? mentioned : [OWNER];
  const title = (ref: string) =>
    ref === OWNER ? "His situation" : `Situation with ${nameOf(ref)}`;
  return [
    ...whole.flatMap((ref) =>
      situationBlock(title(ref), readSituationNow(ref, live))
    ),
    ...refs
      .filter((ref) => !whole.includes(ref))
      .flatMap((ref) =>
        situationBlock(
          `${title(ref)}, on the episodes below`,
          readSituationNow(ref, live).filter((l) =>
            l.cites.some((id) => shown.has(id))
          )
        )
      ),
  ];
}

const orNone = (lines: string[]) => (lines.length > 0 ? lines : ["(none)"]);
const section = (title: string, lines: string[]) =>
  lines.length > 0 ? ["", title, ...lines] : [];

/** A name no one goes by: says so, with the names near it (lifelog's speakers too, but one already on the list is that person). */
function noOne(
  name: string,
  people: { aliases: string[]; id: string; name: string }[],
  heard: { name: string }[]
) {
  const near = nearNames(name, [
    ...people,
    ...heard
      .filter((s) => namedLike(s.name, people).length === 0)
      .map((s) => ({ aliases: [], id: s.name, name: s.name })),
  ]);
  return [
    `No one goes by "${name}".`,
    ...(near.length > 0
      ? [
          "Names near it (`person <id>`):",
          ...near.map((p) => `- ${p.id}: ${p.name}`),
        ]
      : []),
  ];
}

const linkedCount = (db: Database, id: string) =>
  db
    .query<{ n: number }, [string]>(
      `select count(*) as n from links l join observations o on o.id = l.observation where l.entity = ? and ${CURRENT}`
    )
    .get(`person:${id}`)?.n ?? 0;

/** An episode of `read_day`: where he was during it (a stay, when lifelog says) and its key facts (`readBy`). */
export interface DayEpisode {
  episode: Episode;
  facts: string[];
  stay?: string;
}

/** A unit's episode among those shown (`readBy`'s pick), else undefined: its facts then sit under no episode. */
export const shownEpisode =
  (byEpisode: Map<string, Episode>, shown: Set<Episode>) => (unit: string) => {
    const m = byEpisode.get(unit);
    return m && shown.has(m) ? m : undefined;
  };

/**
 * The lines of `read_day`: the birthdays coming (`birthdaysNear`), what is due that day (`dueOf`), what he did (its
 * episodes in time order, each with where he was, what happened and its key facts), the key facts in no episode, its units
 * (conversations, chats, mail and the rest; those judged worth nothing only counted), then what Life changed for him.
 * `whereUnknown`: lifelog could not be read, so where he was is not shown.
 */
export function dayLines({
  actions = [],
  born = [],
  due = [],
  facts = [],
  episodes = [],
  units = [],
  whereUnknown = false,
}: {
  actions?: readonly LedgerEntry[];
  born?: string[];
  due?: string[];
  facts?: string[];
  episodes?: DayEpisode[];
  units?: UnitRow[];
  whereUnknown?: boolean;
}) {
  const noise = units.filter((u) => u.importance === 0).length;
  return [
    ...(born.length > 0
      ? [`Birthdays (this day and the next ${BIRTHDAY_DAYS}):`, ...born, ""]
      : []),
    ...(due.length > 0
      ? [
          "Due (open items, most pressing first: to-dos, promises and his reminders for this day or up to a week overdue, waiting items on their day, undated ones and replies he owes the day after and 3 days after):",
          ...due,
          "",
        ]
      : []),
    ...(episodes.length > 0
      ? [
          "Episodes (what he did, in time order):",
          ...episodes.flatMap(({ facts: of, episode, stay }) => [
            episodeLine(episode),
            ...(stay ? [`    Where he was: ${stay}`] : []),
            ...(episode.what ? [`    ${episode.what}`] : []),
            ...of.map((f) => `    ${f}`),
          ]),
          ...(whereUnknown
            ? ["Where he was is unknown: lifelog could not be read."]
            : []),
          "",
        ]
      : []),
    ...(facts.length > 0
      ? ["Key observations in no episode:", ...facts, ""]
      : []),
    `Units (${units.length}; \`fetch <unit id>\`${noise > 0 ? `; ${noise} worth nothing not listed` : ""}):`,
    ...units.filter((u) => u.importance !== 0).map(unitLine),
    ...(actions.length > 0
      ? [
          "",
          "Actions (what Life changed, and why):",
          ...actions.map(
            (a) => `- ${time(a.at)} ${a.kind}: ${entryLine(a)} (${a.why})`
          ),
        ]
      : []),
  ];
}

export async function day(date: string) {
  const people = await readPeople();
  const born = (await readBirthdaysNear(people, date)).map(
    (b) => `- ${b.name} (\`person ${b.id}\`): ${b.text}`
  );
  const actions = readLedger().filter(
    (a) => isListed(a) && localDate(a.at) === date
  );
  const all = await episodesWhere(() => true);
  const episodes = all
    .filter(inDays({ from: date, to: date }))
    .toSorted((a, b) => (a.start ?? a.day).localeCompare(b.start ?? b.day));
  const byEpisode = readBy(all);
  // None without lifelog; null when it is set up but could not be read.
  const stays = lifelogMissing()
    ? []
    : await staysOf({ at: date }).catch(() => null);
  const context = await dueContext(date, people);
  return withIndex((db) => {
    const facts = db
      .query<Row & { unit: string }, [string]>(
        `select ${COLUMNS}, o.unit from observations o where o.date = ? and o.importance >= ${KEEP_AT} and ${CURRENT}
           order by o.importance desc, o.at limit ${DAY_FACTS}`
      )
      .all(date);
    const of = shownEpisode(byEpisode, new Set(episodes));
    const factsOf = (m: Episode | undefined) =>
      facts.filter((f) => of(f.unit) === m).map(line);
    return dayLines({
      actions,
      born,
      due: dueOf(db, date, context),
      episodes: episodes.map((episode) => {
        const s = span(episode);
        const stay = s.allDay
          ? undefined
          : stays && stayOf(s.from, s.to, stays);
        return {
          episode,
          facts: factsOf(episode),
          stay: stay ? where(stay) : undefined,
        };
      }),
      facts: factsOf(undefined),
      units: db
        .query<UnitRow, [string]>(
          "select id, date, source, title, topics, importance from units where date = ? order by source, title"
        )
        .all(date),
      whereUnknown: episodes.length > 0 && stays === null,
    });
  });
}

/**
 * What `read_day` lists as due on `date` (`openItems`, apps/server/src/todo-list/items.ts, which merges, times and ranks): the importance-3 promises
 * and waiting items, and the to-dos he said (not a mail's), dated up to `OVERDUE_DAYS` before; his reminders in the
 * ledger; the replies he owes. Who said each, when not him, is labelled.
 */
export function dueOf(
  db: Database,
  date: string,
  { more, ...context }: Awaited<ReturnType<typeof dueContext>>
) {
  const rows = db
    .query<
      Row & {
        at: string;
        projects: string | null;
        whom: string | null;
      },
      [string, string, string, string, string, string]
    >(
      `select ${COLUMNS}, o.at,
         (select group_concat(substr(entity, 9)) from links where observation = o.id and entity like 'project:%') as projects,
         (select entity from links where observation = o.id and entity like 'person:%' and entity != ? order by entity limit 1) as whom
       from observations o where o.importance = 3 and ${CURRENT}
       and (o."when" between ? and ? or (o."when" is null and o.date between ? and ?))
       and (o.type in ('promise', 'waiting_on_someone') or (o.type = 'to_do' and o.speaker = ?)) order by o.at, o.id`
    )
    .all(
      OWNER,
      daysBefore(date, OVERDUE_DAYS),
      date,
      daysBefore(date, AGAIN_DAYS),
      date,
      OWNER
    );
  const said: Candidate[] = rows.map((r) => ({
    at: r.at,
    id: r.id,
    kind: r.type as Candidate["kind"],
    line: line(r),
    // Whoever it is with: the speaker when not him, else the first person it names.
    person:
      r.speaker && r.speaker !== OWNER ? r.speaker : (r.whom ?? undefined),
    projects: r.projects?.split(",") ?? [],
    said: r.when ? undefined : r.date,
    when: r.when ?? undefined,
  }));
  return openItems([...said, ...more], { ...context, date }).map(
    (i) =>
      `${i.line}${i.overdue ? " (overdue)" : ""}${i.merged.length > 0 ? ` (also ${i.merged.join(", ")})` : ""}`
  );
}

/** What `dueOf` needs besides the index, read before it opens (nothing awaits while the index is open). */
async function dueContext(date: string, people: People) {
  const { truth } = people;
  const actions = readLedger();
  const reminders = openLinked(actions).map(({ at, fields: f, key, ref }) => ({
    at,
    id: key,
    kind: "reminder" as const,
    line: `- ${key} reminder: "${f.title}"${f.due ? ` (for ${f.due})` : ""}${f.list ? ` in ${f.list}` : ""}`,
    obs: ref?.startsWith("obs_") ? ref : undefined,
    priority: (f.priority as string | null) ?? undefined,
    urgent: Boolean(f.urgent || f.flagged),
    when: f.due ? `${f.due}`.slice(0, 10) : undefined,
  }));
  // His present gates which days have come; `end` and the said days are recorded days (history).
  const today = dayNow();
  const end = Math.min(
    clock().getTime(),
    dayStart(daysBefore(date, -1)).getTime()
  );
  const levels = new Map(
    [...levelsWith(people)].map(([p, l]) => [
      p,
      Math.min(
        Level.options.indexOf(l.personal),
        Level.options.indexOf(l.work)
      ),
    ])
  );
  return {
    goals: goalProjects(truth.me.goals),
    levels,
    more: [...reminders, ...(await repliesOwed(new Date(end)))],
    shown: await shownDays(date),
    today,
  };
}

/** The days before `date` on which the agent's daily review got each id from `read_day` (the logged `mcp.call` ids). */
async function shownDays(date: string) {
  const days = new Map<string, Set<string>>();
  const calls = await recentEvents<Call>(OVERDUE_DAYS + 2, "mcp.call");
  for (const c of calls) {
    const on = localDate(c.at);
    if (isReviewCall(c) && on < date) {
      for (const id of c.ids ?? []) {
        days.set(id, (days.get(id) ?? new Set()).add(on));
      }
    }
  }
  return new Map([...days].map(([id, d]) => [id, [...d]]));
}

/** The area an id or a name (any case or accents) means: an area's own, or a project's, with the project. */
export function areaFor(
  name: string,
  { areas, projects }: Pick<Truth, "areas" | "projects">
) {
  const is = (x: { id: string; name: string }) =>
    x.id === name || normalize(x.name) === normalize(name);
  const project = projects.find(is);
  return { id: project?.area ?? areas.find(is)?.id, project };
}

/**
 * `bun life memory area <id or name>`: an area's page and latest observations. A project's id or name reads its area,
 * after the project's line; a name that is neither lists the ids.
 */
export async function area(name: string) {
  const truth = await loadTruth();
  const { id, project } = areaFor(name, truth);
  if (!id) {
    return `No area or project "${name}". Areas: ${truth.areas.map((a) => a.id).join(", ")}. Projects: ${truth.projects.map((p) => p.id).join(", ")}.`;
  }
  const file = Bun.file(pagePath(`area:${id}`));
  const text = (await file.exists()) ? await file.text() : null;
  return withIndex((db) => [
    ...(project
      ? [
          `Project ${project.name} (${project.id}, ${project.status}), in area ${id}${project.deadlines.map((d) => `; ${d.date}: ${d.what}`).join("")}`,
          "",
        ]
      : []),
    ...entity(db, text, latest(db, "where o.area = ?", id).map(line)),
  ]);
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
        : ["(no topics yet: run episodes)"];
    }
    const wanted = normalizeTopics([tag])[0] ?? tag;
    const rows = db
      .query<UnitRow & { importance: number; type: string }, string[]>(
        `select u.id, u.date, u.source, u.title, u.topics, u.importance, u.type from units u
         join unit_topics t on t.unit = u.id where t.topic = ?${involving} order by u.date, u.id`
      )
      .all(wanted, ...args);
    return [
      `${rows.length} units tagged "${wanted}"${who ? ` involving ${who}` : ""}:`,
      ...rows.map(
        (r) => `${unitLine(r)} (${r.type}, importance ${r.importance})`
      ),
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
  const inferredPeople = [...new Map(inferred.map((p) => [p.id, p])).values()]
    .sort((a, b) => b.confidence - a.confidence)
    .map(
      (p) =>
        `- person:${p.id} (${p.confidence}${p.confidence < INFERRED_USE_AT ? ", not used" : ""}): ${p.name}, ${p.relation}${p.area ? `, ${p.area}` : ""}. ${p.surfaces.join(" / ")}; ${p.evidence.length} quotes, ${about.get(`person:${p.id}`) ?? 0} observations`
    );
  return [
    `People Life inferred (${inferredPeople.length}; used from confidence ${INFERRED_USE_AT}, below truth/ and your corrections):`,
    ...(inferredPeople.length > 0 ? inferredPeople : ["(none)"]),
    "",
    `Names not placed (${names.size}; ${resolved} sightings of names that now resolve are left out). Top ${Math.min(top, names.size)}:`,
    ...lines,
  ].join("\n");
}

const FTS = "tokenize = 'unicode61 remove_diacritics 2'";
const INDEX_SCHEMA = `
create table observations (
  id text primary key, unit text, date text, at text, type text, area text, importance integer, confidence real,
  speaker text, channel text, ref text, text text, quote text, valid_from text, valid_to text, "when" text,
  superseded_by text, home text, detail text);
create index observations_home on observations (home);
create virtual table search using fts5(id unindexed, text, quote, ${FTS});
create table links (observation text, entity text, primary key (observation, entity));
create index links_entity on links (entity);
create table units (
  id text primary key, date text, source text, title text, importance integer, type text, area text, topics text);
create virtual table unit_search using fts5(id unindexed, title, summary, topics, ${FTS});
create table unit_topics (unit text, topic text, primary key (unit, topic));
create table unit_people (unit text, person text, primary key (unit, person));
create index unit_topics_topic on unit_topics (topic);
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
    for (const t of tags) {
      unitTopic.run(u.id, t);
    }
    for (const p of u.people) {
      unitPerson.run(u.id, p);
    }
  }
}

/** The page each observation is a line of (`placed`) and the detail it states (`detailOf`), as the index files it. */
interface Filed {
  detail: (o: Observation) => Detail | null;
  home: (o: Observation) => string | null;
}
const NOT_FILED: Filed = { detail: () => null, home: () => null };

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
  filed: Filed = NOT_FILED
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
    const row = insertInto(db, "observations", 19);
    const text = insertInto(db, "search", 3);
    const link = insertInto(db, "links", 2);
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
        retired?.by ?? null,
        filed.home(o),
        filed.detail(o)
      );
      text.run(o.id, o.text, o.quote);
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
        `select o.date as at, ${OBSERVATION_TEXT} as text from observations o where ${CURRENT}`
      )
      .all(),
    ...db
      .query<Searched, []>(
        `select u.date as at, ${UNIT_TEXT} as text from unit_search s join units u on u.id = s.id`
      )
      .all(),
  ]);
  const chats = readChatTexts();
  return {
    isWhole: indexed !== null && chats.failed.length === 0,
    texts: [
      ...(indexed ?? []),
      ...episodes.map((m) => ({ at: daysOf(m)[0], text: episodeTextNow(m) })),
      ...chats.texts,
    ],
  };
}

/** Every person's details now (`detailsOf`): truth/, his Contacts (whose by `resolve`) and the tagged facts on their page. */
export function readDetailsOf(
  people: Pick<People, "resolve" | "truth">,
  records: Contact[] = readContactRecords()
) {
  const contacts = new Map<string, Contact[]>();
  for (const c of records) {
    const ref = c.handles.map(people.resolve).find(Boolean);
    if (ref) {
      contacts.set(ref, [...(contacts.get(ref) ?? []), c]);
    }
  }
  const facts = Map.groupBy(
    readIndex((db) =>
      db
        .query<DetailFact & { home: string }, []>(
          `select o.id, o.text, o.date, o."when", o.detail, o.home from observations o
           where o.detail is not null and o.home is not null and ${CURRENT}`
        )
        .all()
    ) ?? [],
    (f) => f.home
  );
  const mapped = new Map(people.truth.people.map((p) => [`person:${p.id}`, p]));
  return (ref: string) =>
    detailsOf({
      contacts: contacts.get(ref) ?? [],
      facts: facts.get(ref) ?? [],
      person: mapped.get(ref),
    });
}

/** The birthdays of the coming week (`birthdaysNear`) of everyone on his map or with a page. */
export async function readBirthdaysNear(people: People, date: string) {
  const detailsFor = readDetailsOf(people);
  const refs = new Set([
    ...people.truth.people.map((p) => `person:${p.id}`),
    ...(await pagedNow(people)),
  ]);
  return birthdaysNear(
    [...refs].map((ref) => ({
      birthday: birthdayIn(detailsFor(ref)),
      id: ref.replace(PERSON, ""),
      name: people.nameOf(ref),
    })),
    date
  );
}

/** Rebuilds the index from the ledger and the units; what the owner said is wrong or unimportant is not searchable. */
export async function reindex() {
  const at = clock();
  const [people, verdicts] = await Promise.all([readPeople(), readVerdicts()]);
  const units = indexedOf(await readUnits(), people, verdicts);
  const { observations, standing } = await observationsNow(people);
  const paged = await pagedNow(people);
  const tags = readDetailTags();
  const homes = new Map(
    [...placed(observations, people.truth, paged).homes].flatMap(
      ([home, lines]) => lines.map(({ o }) => [o.id, home] as const)
    )
  );
  const n = buildIndex(observations, INDEX, standing, units, at, {
    detail: (o) => detailOf(o, tags),
    home: (o) => homes.get(o.id) ?? null,
  });
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

/** How close someone is to him, personal and work, and why (`closeness.jsonl`, his word over it); none when not judged. */
function closenessLine(ref: string, people: People) {
  const l = levelsWith(people).get(ref);
  return l
    ? [
        `Closeness: personal ${l.personal}, work ${l.work}${l.service ? " (a service, not a person)" : ""}: ${l.why}`,
        "",
      ]
    : [];
}
