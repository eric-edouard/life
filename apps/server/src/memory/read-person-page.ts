import type { Database } from "bun:sqlite";
import { clock, HOUR } from "../core/clock";
import { newestDays, within } from "../core/lists";
import type { Episode } from "../records/episode";
import { SubjectRef } from "../records/fields";
import type { History } from "../records/history";
import { conversationsWith, speakers, withStore } from "../sources/lifelog";
import { closenessLine } from "./closeness";
import { notCapturedOf, readCoverage } from "./coverage";
import { detailsBlock, readDetailsOf } from "./details";
import {
  type ExchangeCounts,
  pairCountsOf,
  readExchangeCounts,
} from "./exchange-counts";
import { EXCHANGE_ENDS_AFTER } from "./exchanges";
import { readHistory } from "./histories";
import {
  CURRENT,
  episodeLine,
  latest,
  line,
  pageBlock,
  section,
  withIndex,
} from "./index-rows";
import { daysOf, episodesWhere, pagePath, writtenPeople } from "./memory-files";
import { parsePage, slugOf } from "./page-format";
import { episodeTitleLines } from "./person-episode-titles";
import { personaBlock, readPersona } from "./personas";
import { openWithOf, readOpenItems } from "./read-open-items";
import {
  nextReads,
  PART_CHARS,
  partErrorOf,
  type ReadPart,
  type ReadPartRef,
} from "./read-part";
import { goalProjects } from "./read-truth";
import { readSituationNow, situationBlock } from "./situations";
import { clip, nameKey } from "./units";
import { meant, namedLike, nearNames, readPeople } from "./who";
import { asData } from "./words";
import { dayNow, localDate, localTime, monthsOf } from "./zones";

// `bun life memory person [name]` and the connector's `read_person_page`: a person's page, what Life holds about them,
// their observations, episodes and recorded conversations, paged back by day; with no name, the people.

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
        "select substr(l.subject, 8) as id, max(o.at) as at from observation_subjects l join observations o on o.id = l.observation where l.subject like 'person:%' group by l.subject"
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
  kind: "conversation" | "episode" | "month" | "observation";
  line: string;
}

const total = (rows: { n: number }[]) => rows.reduce((a, r) => a + r.n, 0);

const daysLine = (title: string, by: Map<string, number>) =>
  by.size > 0
    ? `; ${title}: ${[...by].map(([s, n]) => `${s} ${n} day${n === 1 ? "" : "s"}`).join(", ")}`
    : "";

/**
 * What Life holds about someone, by source and by `grain` (month or year), and what it can't hold, so a short answer
 * never reads as "nothing happened": each period says the days a source of theirs (one that captures on its own and
 * holds a unit with them) was not captured (`notCapturedOf`). `timeline`: everything the person's answer pages
 * through. With a `span` (a year, or a month) only its periods, without the sources and the closing line.
 */
export function heldLines(
  db: Database,
  ref: string,
  timeline: Dated[],
  grain: "month" | "year" = "month",
  span?: string
) {
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
  const size = grain === "year" ? 4 : 7;
  const inSpan = units.filter((u) => !span || u.m.startsWith(span));
  const byPeriod = Map.groupBy(inSpan, (u) => u.m.slice(0, size));
  const dated = timeline.filter((t) => !span || t.day.startsWith(span));
  const periods = [
    ...new Set([...byPeriod.keys(), ...dated.map((t) => t.day.slice(0, size))]),
  ].sort();
  const count = (p: string, kind: Dated["kind"]) =>
    dated.filter((t) => t.kind === kind && t.day.startsWith(p)).length;
  const [first] = periods;
  const coverage = first
    ? readCoverage(
        db,
        first.length === 4 ? `${first}-01-01` : `${first}-01`,
        span && `${span}-12-31` < dayNow() ? `${span}-12-31` : dayNow()
      )
    : { days: new Map(), sources: [] };
  const theirs = coverage.sources.filter((c) =>
    sources.some(([s]) => s === c.name)
  );
  const missed = notCapturedOf(coverage.days, theirs);
  const since = (s: string) => theirs.find((c) => c.name === s)?.firstDay;
  const gapsOf = (p: string) => {
    const sum = { not_seen: new Map<string, number>(), unknown: new Map() };
    for (const [m, gaps] of missed) {
      for (const kind of ["not_seen", "unknown"] as const) {
        for (const [s, n] of m.startsWith(p) ? gaps[kind] : []) {
          sum[kind].set(s, (sum[kind].get(s) ?? 0) + n);
        }
      }
    }
    return (
      daysLine("not seen", sum.not_seen) + daysLine("unknown", sum.unknown)
    );
  };
  return [
    ...(span
      ? []
      : [
          "What Life holds about them (older chats are only in the archive: `chats` with `who` and `from`):",
          ...sources.map(
            ([s, rows]) =>
              `- ${s}: ${total(rows)} units, ${rows.map((r) => r.first).sort()[0]} to ${rows
                .map((r) => r.last)
                .sort()
                .at(-1)}${since(s) ? ` (Life holds it since ${since(s)})` : ""}`
          ),
        ]),
    `By ${grain} (not seen, unknown: days a source of theirs was not captured, or Life cannot tell; never quiet days):`,
    ...periods.map((p) => {
      const here = (byPeriod.get(p) ?? []).toSorted((a, b) => b.n - a.n);
      const by = [...Map.groupBy(here, (r) => r.source)]
        .sort((a, b) => total(b[1]) - total(a[1]))
        .map(([s, rows]) => `${s} ${total(rows)}`);
      return `- ${p}: ${total(here)} units${by.length > 0 ? ` (${by.join(", ")})` : ""}, ${count(p, "observation")} observations, ${count(p, "episode")} episodes${gapsOf(p)}`;
    }),
    ...(span
      ? []
      : ["Not in Life: calls, and time together that wasn't recorded."]),
  ];
}

/** The ref a part read can open again: a person Life knows, whose id a ref can hold; never a name only heard. */
export function personRefOf(known: string | undefined, id: string) {
  const ref = `person:${id}`;
  return known && SubjectRef.safeParse(ref).success ? ref : undefined;
}

/** `meant`'s answer, but a part read by id (`byId`) takes the person with exactly that id before any name or alias. */
export function personFor(
  name: string,
  meaning: ReturnType<typeof meant>,
  byId?: boolean
) {
  const exact = byId ? meaning.all.find((p) => p.id === name) : undefined;
  return exact ? { ...meaning, known: exact.id, same: [] } : meaning;
}

/**
 * A person, read in parts (`read-part.ts`). `now`, the default: who they are to him and where things stand: candidates
 * when two people go by the name, their details, closeness, the last exchange, what is open between them, their
 * Situation and what their time together was about; then `page` (who they are, the page Life wrote), `persona` (what
 * they are like, how each writes), `story` (their history's story, what code counted and what Life holds, by year),
 * `year` (its months' summaries, paged back by `before`), `month` (its words and days) and `evidence` (their
 * observations, episodes and recorded conversations, newest first by whole days, in a `span` and paged back by
 * `before`). Each part ends with its next reads, written by code. A name two people go by lists them, then reads the
 * first; a name on no page nor directory entry is looked for among lifelog's speakers, and someone only heard has no
 * parts (nothing to address them by): `now` shows their evidence, paged back with `before`; a name no one goes by
 * says so and lists the names near it.
 */
export async function person(
  name?: string,
  o: { before?: string; byId?: boolean; part?: string; span?: string } = {}
) {
  if (!name) {
    const list = await peoplePages();
    return withIndex((db) => {
      const pages = withPages(db, list);
      return pages.length > 0 ? pages : ["(no people pages yet)"];
    });
  }
  // Pages go by whole local days: a day is never cut between two answers.
  const before = o.before?.slice(0, 10);
  const part = o.part ?? (before || o.span ? "evidence" : "now");
  const bad = partErrorOf({ before, part, span: o.span });
  if (bad) {
    return asData([`(${bad})`]);
  }
  const folks = await readPeople();
  const { refOf, truth } = folks;
  const {
    all: people,
    known,
    same,
  } = personFor(name, meant(name, folks), o.byId);
  // The person's own page, by its id: never one whose file name only holds the name.
  const file = known && Bun.file(pagePath(`person:${known}`));
  const found =
    file && (await file.exists()) ? { text: await file.text() } : null;
  const id = known ?? slugOf(name);
  const ref = `person:${id}`;
  const partRef = personRefOf(known, id);
  const mapped = truth.people.find((p) => p.id === id);
  const lifelog = mapped?.handles.lifelog;
  const all = await episodesWhere(() => true);
  const live = new Set(all.map((m) => m.id));
  const episodes = all.filter((m) =>
    m.people.some((p) => refOf(p.ref) === ref)
  );
  // What each part needs, read before the index opens (nothing awaits while it is).
  const now = part === "now" && !!partRef;
  const history = ["story", "year", "month"].includes(part)
    ? readHistory(ref)
    : { months: [], schemaVersion: 1 as const, story: null };
  const counted =
    (now || part === "story") && partRef ? readExchangeCounts() : null;
  const rows = counted && { ...counted, rows: counted.people[ref] ?? [] };
  const items = now ? await readOpenItems(folks, clock()) : [];
  return withStore((store) =>
    withIndex((db) => {
      // A name on no page nor directory entry: the lifelog speakers it is part of.
      const voices = speakers(store);
      const heard = known
        ? []
        : voices.filter((s) => nameKey(s.name).includes(nameKey(name)));
      if (!(known || heard.length > 0)) {
        return noOne(name, people, voices);
      }
      if (!partRef && part !== "now" && part !== "evidence") {
        return [
          `(no part "${part}" for someone only heard: read them with \`before\`)`,
        ];
      }
      const timeline = timelineOf(
        db,
        store,
        ref,
        episodes,
        lifelog ? [lifelog] : heard.map((s) => s.id)
      );
      // The lines of the parts that are one block, worked out for the one asked for only.
      const blocks: Record<string, () => string[]> = {
        now: () => [
          ...episodeTitleLines(episodes, (r) => refOf(r) === ref),
          ...detailsBlock(readDetailsOf(folks)(ref), dayNow()),
          ...closenessLine(ref, folks),
          ...lastExchangeLine(rows),
          ...openWithOf(ref, {
            goals: goalProjects(truth.me.goals),
            items,
            today: dayNow(),
          }),
          ...situationBlock("Situation", readSituationNow(ref, live)),
        ],
        page: () => pageBlock(db, found?.text ?? null, "in the evidence"),
        persona: () => personaBlock(readPersona(ref), dayNow()),
      };
      return partLines({
        before,
        candidates: candidateLines(name, same, (who) => linkedCount(db, who)),
        counts: exchangeCountsBlock(rows),
        fixed: partRef ? (blocks[part]?.() ?? []) : [],
        heard,
        held: (grain, span) => heldLines(db, ref, timeline, grain, span),
        history,
        part: part as ReadPart,
        ref: partRef,
        span: o.span,
        timeline,
      });
    })
  );
}

/** One timeline, newest first: the person's observations, episodes and recorded conversations. */
function timelineOf(
  db: Database,
  store: Parameters<typeof speakers>[0],
  ref: string,
  episodes: Episode[],
  voiceIds: string[]
): Dated[] {
  return [
    ...latest(
      db,
      "join observation_subjects l on l.observation = o.id where l.subject = ?",
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
    ...conversationsWith(store, voiceIds).map((c) => ({
      day: localDate(c.start_at),
      kind: "conversation" as const,
      line: `- ${c.id} ${localTime(c.start_at)}: ${clip(c.title, 80)}`,
    })),
  ].toSorted((a, b) => b.day.localeCompare(a.day));
}

const EMPTY_PART = (what: string) => [`(no ${what} yet)`];

/** The first line of a month's or year's heading, as `year` and `month` parts show it. */
const HISTORY_ABOUT =
  "Past months between them and him (Life's history: each closed month of their one-to-one chats and mail, summarised by a model, quotes checked; not groups, recordings or what was said on calls)";

/** What `partLines` is made from: the lines each part holds, and the dated entries it pages. */
interface PartInputs {
  before?: string;
  candidates: string[];
  counts: string[];
  /** The lines of `now`, `page` or `persona`, whichever is asked for. */
  fixed: string[];
  heard: { name: string }[];
  held: (grain: "month" | "year", span?: string) => string[];
  history: History;
  part: ReadPart;
  ref?: string;
  span?: string;
  timeline: Dated[];
}

/** A next read of this person: `read-part.ts` writes it. */
const readOf =
  (o: PartInputs) => (r: Omit<ReadPartRef, "subject">, what: string) => ({
    ref: { ...r, subject: o.ref as string },
    what,
  });
type Read = ReturnType<ReturnType<typeof readOf>>;
const ending = (reads: Read[]) => ["", ...nextReads(reads)];
const EVIDENCE =
  "their observations, episodes and recorded conversations, newest first";
const evidenceRead = (o: PartInputs, span?: string): Read =>
  readOf(o)({ part: "evidence", span }, EVIDENCE);

/** The entries a part shows: newest first by whole days, as many as fit with its fixed lines (at least a day). */
function paged(o: PartInputs, items: Dated[], fixed: string[]) {
  const sorted = items.toSorted((a, b) => b.day.localeCompare(a.day));
  const left = o.before
    ? sorted.filter((t) => t.day < (o.before as string))
    : sorted;
  const room = PART_CHARS - fixed.join("\n").length;
  const fit = within(left, room, (t) => t.line.length + 1).length;
  return newestDays(sorted, (t) => t.day, Math.max(1, fit), o.before);
}

/** The observations, episodes and recorded conversations of a span, and the older call (a ref, or for someone only heard the `before` call). */
function evidenceLines(o: PartInputs) {
  const { next, taken } = paged(
    o,
    o.timeline.filter((t) => !o.span || t.day.startsWith(o.span)),
    []
  );
  const lines = (kind: Dated["kind"]) =>
    taken.filter((t) => t.kind === kind).map((t) => t.line);
  const heading = `Evidence${o.span ? ` in ${o.span}` : ""}${o.before ? `, before ${o.before}` : ""}:`;
  const older = o.ref
    ? nextReads([
        readOf(o)(
          { before: next, part: "evidence", span: o.span },
          "older evidence"
        ),
      ])
    : [`Older: the same call with \`before\` ${next}.`];
  return {
    body: [
      heading,
      "Observations:",
      ...orNone(lines("observation")),
      ...section("Episodes with them:", lines("episode")),
      ...section(recordedTitle(o.heard), lines("conversation")),
    ],
    older: next ? older : ["(nothing older)"],
  };
}

/** The years a person has anything in, newest first, each with its next read. */
function yearReads(o: PartInputs, months: Dated[]) {
  const read = readOf(o);
  const years = [
    ...new Set([...months, ...o.timeline].map((t) => t.day.slice(0, 4))),
  ].toSorted((a, b) => b.localeCompare(a));
  return years.map((y) =>
    months.some((m) => m.day.startsWith(y))
      ? read(
          { part: "year", span: y },
          `${y}: its months' summaries, and what Life holds by month`
        )
      : { ...evidenceRead(o, y), what: `${y}: ${EVIDENCE}` }
  );
}

function storyLines(o: PartInputs, months: Dated[]) {
  const { story } = o.history;
  return [
    ...(months.length > 0 ? [HISTORY_ABOUT] : []),
    ...(story
      ? [`Over the years (through ${story.through}): ${story.text}`, ""]
      : []),
    ...o.counts,
    ...o.held("year"),
    ...ending(yearReads(o, months)),
  ];
}

function yearLines(o: PartInputs, months: Dated[]) {
  const read = readOf(o);
  const span = o.span as string;
  const held = o.held("month", span);
  const mine = months.filter((m) => m.day.startsWith(span));
  const { next, taken } = paged(o, mine, o.before ? [] : held);
  const heading = o.before ? `, before ${o.before}` : "";
  return [
    mine.length > 0
      ? `Months of ${span}, newest first${heading}:`
      : `(no month of ${span} was read yet)`,
    ...taken.map((m) => m.line),
    ...(o.before ? [] : ["", ...held]),
    ...ending([
      ...taken.map((m) =>
        read({ part: "month", span: m.day.slice(0, 7) }, "its words and days")
      ),
      ...(next
        ? [read({ before: next, part: "year", span }, "older months")]
        : []),
      evidenceRead(o, span),
    ]),
  ];
}

const quoteLine = (q: { at: string; text: string; writer: "owner" | "them" }) =>
  `- "${q.text}" (${localDate(q.at)}, ${q.writer === "owner" ? "him" : "them"})`;

/** A month: the words found in it, and which days hold something. */
function monthLines(o: PartInputs) {
  const span = o.span as string;
  const row = o.history.months.find((m) => m.month === span);
  const quotes = (row?.parts ?? []).flatMap((p) => p.quotes).map(quoteLine);
  const days = [
    ...Map.groupBy(
      o.timeline.filter((t) => t.day.startsWith(span)),
      (t) => t.day
    ),
  ]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([d, list]) => {
      const kinds = [...Map.groupBy(list, (t) => t.kind)].map(
        ([k, l]) => `${l.length} ${k}${l.length === 1 ? "" : "s"}`
      );
      return `- ${d}: ${kinds.join(", ")}`;
    });
  let words = [`(no history of ${span} was read yet)`];
  if (row) {
    words = [
      `Their words in ${span} (the month's summary is in ${span.slice(0, 4)}):`,
      ...(quotes.length > 0 ? quotes : ["(none found)"]),
    ];
  }
  return [
    ...words,
    "",
    `Days with evidence in ${span}:`,
    ...orNone(days),
    ...ending([
      evidenceRead(o, span),
      readOf(o)(
        { part: "year", span: span.slice(0, 4) },
        `${span.slice(0, 4)}: its months' summaries`
      ),
    ]),
  ];
}

/**
 * One part of a person's read, from what was gathered. `ref`: the person's ref, absent for someone only heard (their
 * `now` is the evidence, paged back with the older call: nothing can name a part). `fixed` holds the lines of
 * `now`, `page` or `persona`, `counts` those `story` is made of; `history` and `timeline` the dated entries of `year`,
 * `month` and `evidence`; `held`, what Life holds by month or year. A part's dated entries stop at about `PART_CHARS`
 * with its fixed lines, a day never cut (`before`, a day, exclusive, pages back); each part ends with its next reads.
 */
export function partLines(o: PartInputs) {
  const read = readOf(o);
  const months = historyOf(o.history);
  const orEmpty = (lines: string[], what: string) =>
    lines.length > 0 ? lines : EMPTY_PART(what);
  if (o.part === "evidence" || !o.ref) {
    const { body, older } = evidenceLines(o);
    const held = o.part === "evidence" ? [] : ["", ...o.held("month")];
    return [...o.candidates, ...body, ...held, "", ...older];
  }
  switch (o.part) {
    case "now":
      return [
        ...o.candidates,
        ...o.fixed,
        ...ending([
          read({ part: "page" }, "who they are to him, as Life's page says"),
          read({ part: "persona" }, "what they are like and how each writes"),
          read(
            { part: "story" },
            "the years between them: story, counts, what Life holds"
          ),
          evidenceRead(o),
        ]),
      ];
    case "page":
      return [...orEmpty(o.fixed, "page"), ...ending([evidenceRead(o)])];
    case "persona":
      return [
        ...orEmpty(o.fixed, "persona"),
        ...ending([
          read({ part: "story" }, "the years between them"),
          evidenceRead(o),
        ]),
      ];
    case "story":
      return storyLines(o, months);
    case "year":
      return yearLines(o, months);
    default:
      return monthLines(o);
  }
}

/**
 * A person's history (`histories.ts`) as dated entries: each month's summary, on the month's last day (the paging's
 * key), newest first. Its words are the month part's. Nothing when no month was read yet.
 */
export function historyOf(history: History) {
  return history.months.toReversed().map(
    (m): Dated => ({
      // The month's last day: `monthsOf` ends a month's window there.
      day: monthsOf({ from: `${m.month}-01`, to: `${m.month}-31` })[0]
        ?.to as string,
      kind: "month",
      line: `- ${m.month}: ${m.parts.map((p) => p.summary).join(" ")}`,
    })
  );
}

/** The last exchange between them and him, counted: when, who opened it and how many each sent. Nothing when none. */
export function lastExchangeLine(counted: { rows: ExchangeCounts[] } | null) {
  const last = counted?.rows.toSorted((a, b) =>
    b.start.localeCompare(a.start)
  )[0];
  return last
    ? [
        `Last exchange: ${localDate(last.start)}, opened by ${last.heOpened ? "him" : "them"}; he sent ${last.sent}, they sent ${last.got}.`,
      ]
    : [];
}

/**
 * What code counts between him and one person (`exchange-counts.ts`): all years, then each year an exchange started
 * in, newest first. Nothing when none was counted (no file yet, or no one-to-one exchange with them): never zeros.
 */
export function exchangeCountsBlock(
  counted: { built: string; rows: ExchangeCounts[]; sources: string[] } | null
) {
  if (!counted || counted.rows.length === 0) {
    return [];
  }
  const answer = (minutes: number | null) =>
    minutes === null ? "none" : `${minutes} min`;
  const counts = (label: string, rows: ExchangeCounts[]) => {
    const c = pairCountsOf(rows);
    return `- ${label}: messages on ${c.days} days; he sent ${c.sent} (${c.sentDeleted} deleted), they sent ${c.got} (${c.gotDeleted} deleted); exchanges opened: he ${c.heOpened}, they ${c.theyOpened}; median answer: he ${answer(c.heAnswersIn)}, they ${answer(c.theyAnswerIn)}`;
  };
  const years = [
    ...Map.groupBy(counted.rows, (r) => localDate(r.start).slice(0, 4)),
  ].sort(([a], [b]) => b.localeCompare(a));
  return [
    `Counted by code between them and him, through ${localDate(counted.built)} (their one-to-one chats and mail threads: ${counted.sources.join(", ")}; not groups nor recordings; a call counts as a message; an exchange lasts until ${EXCHANGE_ENDS_AFTER / HOUR} hours of quiet and is opened by whoever writes first):`,
    counts("all years", counted.rows),
    ...years.map(([year, rows]) => counts(year, rows)),
    "",
  ];
}

/** `heard`: the lifelog speakers a name on no page nor directory entry was found among. */
const recordedTitle = (heard: { name: string }[]) =>
  `Recorded conversations${heard.length > 0 ? ` with lifelog speakers named ${[...new Set(heard.map((s) => s.name))].join(", ")}` : ""} (\`fetch <id>\`):`;

const orNone = (lines: string[]) => (lines.length > 0 ? lines : ["(none)"]);

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
      `select count(*) as n from observation_subjects l join observations o on o.id = l.observation where l.subject = ? and ${CURRENT}`
    )
    .get(`person:${id}`)?.n ?? 0;
