import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { clock, DAY } from "../core/clock";
import { type Call, isReviewCall, recentEvents } from "../core/log";
import type { SourceName } from "../core/names";
import { redact } from "../core/redact";
import { openReadOnly } from "../core/sqlite";
import { isListed, type LedgerEntry } from "../records/ledger-entry";
import type { Moment } from "../records/moment";
import {
  INFERRED_USE_AT,
  Level,
  type Observation,
} from "../records/observation";
import type { Person } from "../records/truth";
import type { Unit, Verdict } from "../records/unit";
import { KEEP_AT } from "../records/unit";
import {
  conversationsWith,
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
import { levelsWith } from "./closeness";
import {
  daysOf,
  momentsNow,
  OUT,
  pagePath,
  readCorrections,
  readLedger,
  readMoments,
  readUnits,
  readUnresolved,
  readVerdicts,
  type Standing,
  stateOf,
  tasksOf,
  verdictOf,
  writtenPeople,
} from "./ledger";
import { SURE_AT } from "./observe";
import { bodyOf, generated, parsePage, renderLine } from "./page-format";
import { goalProjects, loadTruth, OWNER, type Truth } from "./read-truth";
import { kindOf, listening } from "./sources";
import { closed, nameOf, standing as taskStanding } from "./tasks";
import {
  clip,
  dayRange,
  daysBefore,
  localTime,
  newestDays,
  normalize,
  normalizeTopics,
  slugOf,
  time,
} from "./units";
import {
  meant,
  who as named,
  namedLike,
  nearNames,
  observationsNow,
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
  repliesOwed,
} from "./words";
import { dayNow, dayStart, localDate, when } from "./zones";

// The read path, as `bun life memory search|person|area` (apps/server/src/host/command.ts): short cited results from the pages
// and derived/memory/index.sqlite. It also owns the index: buildIndex writes it, nothing else here writes.
//   search <words>   moments, observations and units matching the words, the exact spoken words (lifelog's search) and chats
//   day <date>       what happened that day (its moments), its units (recorded conversations among them) and its key
//                    observations
//   person [name]    a person's page, what Life holds about them, their observations, moments and recorded conversations,
//                    paged back by day; with no name, the people
//   area <id>        an area's page and latest observations
//   topics [tag]     the top topics, or the units tagged so, by date (--person <id>: only units involving them)
//   unresolved       names Life could not map to truth/, most seen first

export const INDEX = join(OUT, "index.sqlite");
const LIMIT = 12;
/** A section's first LIMIT lines (its last, `newest`), saying so when there were more. */
const cut = (lines: string[], newest = false) =>
  lines.length > LIMIT
    ? [
        ...(newest ? lines.slice(-LIMIT) : lines.slice(0, LIMIT)),
        `(cut at ${LIMIT}: narrow with \`from\` and \`to\`)`,
      ]
    : lines;

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
/** A moment that has a day inside `r`. */
const inDays = (r: Days) => (m: Moment) => daysMeet(r, ...daysOf(m));

export function matches(db: Database, q: string, range: Days = {}) {
  const o = between("o.date", range);
  const u = between("u.date", range);
  const sql = `select ${COLUMNS} from search s join observations o on o.id = s.id
    where search match ? and ${CURRENT}${o.sql} order by rank limit ${LIMIT + 1}`;
  const unitSql = `select u.id, u.date, u.source, u.title, u.topics from unit_search s join units u on u.id = s.id
    where unit_search match ?${u.sql} order by rank limit ${LIMIT + 1}`;
  const found = (query: string) => ({
    observations: db
      .query<Row, string[]>(sql)
      .all(query, ...o.args)
      .map(line),
    units: db
      .query<UnitRow, string[]>(unitSql)
      .all(query, ...u.args)
      .map(unitLine),
  });
  for (const mode of ["AND", "OR"] as const) {
    const query = ftsQuery(q, mode);
    const { observations, units } = query
      ? found(query)
      : { observations: [], units: [] };
    if (observations.length + units.length > 0) {
      return [
        ...cut(observations),
        ...(units.length > 0
          ? ["", "Units (titles, summaries, topics):", ...cut(units)]
          : []),
      ];
    }
  }
  return ["(nothing found)"];
}

/** The observations `where` finds worth a page line, newest first: `limit` of them (-1: all). */
function latest(db: Database, where: string, value: string, limit = LIMIT) {
  return db
    .query<Row, [string]>(
      `select ${COLUMNS} from observations o ${where} and o.importance >= ${KEEP_AT} and ${CURRENT}
       order by o.date desc, o.at desc limit ${limit}`
    )
    .all(value);
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
  const db = openReadOnly(INDEX);
  try {
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

/** What the agent wrote on a task's lines: its words, not its fields (a state or a deadline matches nothing). */
const REPORTS = ["note", "outcome", "reason", "question", "text"];

/**
 * The tasks whose words (his ask, its title) or the agent's own lines (notes, outcomes, replies) hold every word, asked
 * between `from` and `to`, oldest first; matched when read, never checked against his memory.
 */
export function taskHits(
  holds: (text: string) => boolean,
  o: Days,
  tasks = tasksOf()
) {
  return tasks
    .filter(
      (t) =>
        daysMeet(o, localDate(t.ask.at)) &&
        holds(
          [
            t.ask.instruction.quote,
            t.ask.after.title,
            ...t.lines.flatMap((l) => REPORTS.map((k) => l.after[k])),
          ]
            .filter((x) => typeof x === "string")
            .join(" ")
        )
    )
    .map((t) => {
      const { state, word } = taskStanding(t);
      return `- ${t.ask.id} ${localDate(t.ask.at)} ${state}: ${nameOf(t)}${word ? ` → ${clip(`${word}`, 200)}` : ""}`;
    });
}

/** `from`/`to` (local days, both included) bound every section. */
export async function search(words: string, o: Days = {}) {
  const range = dayRange(o.from, o.to);
  // lifelog's search is a network call: the chats are read meanwhile.
  const holds = holdsAll(words);
  const [voice, chats, mail, found] = await Promise.all([
    voiceHits(words, range),
    chatHits(words, range),
    mailHits(words, range),
    momentsWhere((m) => inDays(o)(m) && holds(`${m.title} ${m.place ?? ""}`)),
  ]);
  const tasks = taskHits(holds, o);
  return withIndex((db) => [
    ...(found.length > 0
      ? [
          "Moments (what happened or is planned):",
          ...cut(found.map(momentLine), true),
          "",
        ]
      : []),
    ...(tasks.length > 0
      ? [
          "Agents' tasks (their own reports, not checked by Life):",
          ...cut(tasks, true),
          "",
        ]
      : []),
    ...(found.length + tasks.length > 0 ? ["Observations and units:"] : []),
    ...matches(db, words, o),
    "",
    `Voice (exact spoken words, the best ${VOICE_LIMIT}: narrow with \`from\`/\`to\` for others; conversation id, time, turn: \`fetch <id> --from-turn <turn>\`):`,
    ...voice,
    "",
    "Chats and notes (messages and note versions holding all the words, with the ones around them; each heading says where to read more):",
    ...chats,
    "",
    `Mail (no newsletters: the newest ${MAIL_HITS} holding all the words; each its unit, \`fetch <unit>\` for the thread):`,
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
  kind: "conversation" | "moment" | "observation";
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
      return `- ${m}: ${total(here)} units${by ? ` (${by})` : ""}, ${count(m, "observation")} observations, ${count(m, "moment")} moments`;
    }),
    "Not in Life: calls, and time together that wasn't recorded.",
  ];
}

/**
 * A person: their page, whole, and what Life holds about them by source and month; then their observations (every
 * one linked to them, whatever page it lives on) and the moments with them, newest first by whole days, and their
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
  const birthday = mapped?.birthday
    ? [`Birthday: ${birthdayText(nextBirthday(mapped.birthday, dayNow()))}`, ""]
    : [];
  const close = await closenessLine(ref);
  // Pages go by whole local days: a day is never cut between two answers.
  const before = o.before?.slice(0, 10);
  const moments = await momentsWhere((m) =>
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
      // One timeline, newest first, paged once: observations, moments and recorded conversations.
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
        ...moments.toReversed().map((m) => ({
          day: daysOf(m)[0],
          kind: "moment" as const,
          line: momentLine(m),
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
              ...birthday,
              ...close,
              ...entity(db, found?.text ?? null, obsLines),
              "",
              ...coverageLines(db, ref, timeline),
            ]),
        ...section("Moments with them:", lines("moment")),
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

/**
 * The lines of `read_day`: the birthdays coming (`birthdaysNear`), what is due that day (`dueOf`), what happened (its moments,
 * planned ones included), its units (conversations, chats, mail and the rest), its key observations,
 * then what Life changed for him.
 */
export function dayLines({
  actions = [],
  born = [],
  due = [],
  facts = [],
  moments = [],
  units = [],
}: {
  actions?: LedgerEntry[];
  born?: string[];
  due?: string[];
  facts?: string[];
  moments?: Moment[];
  units?: UnitRow[];
}) {
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
    ...(moments.length > 0
      ? [
          "Moments (what happened or is planned):",
          ...moments.map(momentLine),
          "",
        ]
      : []),
    `Units (${units.length}; \`fetch <unit id>\`):`,
    ...units.map(unitLine),
    ...(facts.length > 0 ? ["", "Key observations:", ...facts] : []),
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
  const truth = await loadTruth();
  const born = birthdaysNear(truth.people, date);
  const actions = (await readLedger()).filter(
    (a) => isListed(a) && localDate(a.at) === date
  );
  const moments = await momentsWhere(inDays({ from: date, to: date }));
  const context = await dueContext(date, truth);
  return withIndex((db) =>
    dayLines({
      actions,
      born,
      due: dueOf(db, date, context),
      facts: db
        .query<Row, [string]>(
          `select ${COLUMNS} from observations o where o.date = ? and o.importance >= ${KEEP_AT} and ${CURRENT}
             order by o.importance desc, o.at limit ${DAY_FACTS}`
        )
        .all(date)
        .map(line),
      moments,
      units: db
        .query<UnitRow, [string]>(
          "select id, date, source, title, topics from units where date = ? order by source, title"
        )
        .all(date),
    })
  );
}

/** How far ahead `read_day` lists birthdays: a week, so the agent sees one coming a week ahead and on the day. */
const BIRTHDAY_DAYS = 7;

/**
 * A birthday (`--MM-DD`, or `YYYY-MM-DD`) seen from `today`: its next date, the days left, and the age then when the
 * year is known.
 */
export function nextBirthday(birthday: string, today: string) {
  const [year = 0, month = 1, dom = 1] = birthday
    .replace("--", "0-")
    .split("-")
    .map(Number);
  const from = Date.parse(`${today}T00:00:00Z`);
  const on = (y: number) => Date.UTC(y, month - 1, dom);
  // ponytail: a 29 Feb birthday falls on 1 Mar in other years (Date.UTC rolls over).
  let at = on(Number(today.slice(0, 4)));
  if (at < from) {
    at = on(Number(today.slice(0, 4)) + 1);
  }
  const next = new Date(at).toISOString().slice(0, 10);
  return {
    age: year ? Number(next.slice(0, 4)) - year : null,
    day: next,
    left: Math.round((at - from) / DAY),
  };
}

/** A `nextBirthday` as "12 Nov (in 3 days, turns 33)". */
export const birthdayText = (b: ReturnType<typeof nextBirthday>) =>
  `${when(b.day).date} (${b.left === 0 ? "today" : `in ${b.left} day${b.left === 1 ? "" : "s"}`}${b.age ? `, turns ${b.age}` : ""})`;

/**
 * The birthdays from `date` to `BIRTHDAY_DAYS` later of everyone on his map with one: he wrote each, so each person
 * matters to him. Soonest first.
 */
export const birthdaysNear = (
  people: Pick<Person, "birthday" | "id" | "name">[],
  date: string
) =>
  people
    .flatMap((p) =>
      p.birthday ? [{ b: nextBirthday(p.birthday, date), p }] : []
    )
    .filter(({ b }) => b.left <= BIRTHDAY_DAYS)
    .toSorted((x, y) => x.b.left - y.b.left)
    .map(({ b, p }) => `- ${p.name} (\`person ${p.id}\`): ${birthdayText(b)}`);

/**
 * What `read_day` lists as due on `date` (`openItems`, apps/server/src/todo-list/items.ts, which merges, times and ranks): the importance-3 promises
 * and waiting items, and the to-dos he said (not a mail's), dated up to `OVERDUE_DAYS` before; his reminders in the
 * ledger; the replies he owes. Who said each, when not him, is labelled. The agent's daily review lists them (docs/agent.md).
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
        ref: string;
        whom: string | null;
      },
      [string, string, string, string, string, string]
    >(
      `select ${COLUMNS}, o.at, o.ref,
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
    ref: r.ref,
    said: r.when ? undefined : r.date,
    when: r.when ?? undefined,
  }));
  return openItems([...said, ...more], { ...context, date }).map(
    (i) =>
      `${i.line}${i.overdue ? " (overdue)" : ""}${i.merged.length > 0 ? ` (also ${i.merged.join(", ")})` : ""}`
  );
}

/** What `dueOf` needs besides the index, read before it opens (nothing awaits while the index is open). */
async function dueContext(date: string, truth: Truth) {
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
    [...levelsWith(await readCorrections())].map(([p, l]) => [
      p,
      Math.min(
        Level.options.indexOf(l.personal),
        Level.options.indexOf(l.work)
      ),
    ])
  );
  const open = tasksOf().filter((t) => !closed(taskStanding(t).state));
  return {
    goals: goalProjects(truth.me.goals),
    levels,
    more: [...reminders, ...(await repliesOwed(new Date(end)))],
    shown: await shownDays(date),
    tasks: new Set(open.map((t) => t.ask.instruction.ref)),
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
        : ["(no topics yet: run moments)"];
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
  superseded_by text);
create virtual table search using fts5(id unindexed, text, quote, ${FTS});
create table links (observation text, entity text, primary key (observation, entity));
create index links_entity on links (entity);
create table units (
  id text primary key, date text, source text, title text, importance integer, type text, area text, topics text);
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
 * one, and its end date), full-text search over claims and quotes, links; and the units (titles, a chapter's or repo-day's summary and
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
    // Who a unit is with as of today; the table keeps each once.
    unit: unitNow(unit, people.refOf),
    verdict: verdictOf(verdicts, unit),
  }));
  const { observations, standing } = await observationsNow(people);
  const n = buildIndex(observations, INDEX, standing, units);
  // On stderr: the app reads a command's stdout as its answer, and the first command after an update may rebuild.
  console.error(
    `${n} observations and ${units.length} units indexed in ${INDEX}`
  );
}

/** How close someone is to him, personal and work, and why (`closeness.jsonl`, his word over it); none when not judged. */
async function closenessLine(ref: string) {
  const l = levelsWith(await readCorrections()).get(ref);
  return l
    ? [
        `Closeness: personal ${l.personal}, work ${l.work}${l.service ? " (a service, not a person)" : ""}: ${l.why}`,
        "",
      ]
    : [];
}
