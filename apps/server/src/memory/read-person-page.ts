import type { Database } from "bun:sqlite";
import { clock } from "../core/clock";
import { newestDays, within } from "../core/lists";
import type { Episode } from "../records/episode";
import { SubjectRef } from "../records/fields";
import { speakers, withStore } from "../sources/lifelog";
import { conversationsWith } from "../sources/lifelog-conversations";
import { closenessLine } from "./closeness";
import {
  communicationStyleBlock,
  readCommunicationStyle,
} from "./communication-styles";
import { conversationSummaryPart } from "./conversation-summaries";
import { notCapturedOf, readCoverage } from "./coverage";
import { detailsBlock, readDetailsOf } from "./details";
import { type ExchangeCounts, readExchangeCounts } from "./exchange-counts";
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
import { openWithOf, readOpenItems } from "./read-open-items";
import {
  ADD_ON_PARTS,
  nextReads,
  PART_CHARS,
  partErrorOf,
  READ_PARTS,
  type ReadPart,
  type ReadPartRef,
} from "./read-part";
import { goalProjects, isDirectoryNew, OWNER } from "./read-truth";
import { readSituationNow, situationBlock } from "./situations";
import { conversationLabel, lifelogNames, nameKey } from "./units";
import { meant, namedLike, nearNames, readPeople } from "./who";
import { asData } from "./words";
import { dayNow, localDate } from "./zones";

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
export interface Dated {
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
 * What Life holds about someone, by source and by month, and what it can't hold, so a short answer never reads as
 * "nothing happened": each month says the days a source of theirs (one that captures on its own and holds a unit
 * with them) was not captured (`notCapturedOf`). `timeline`: everything the person's answer pages through. With a
 * `span` (a year, or a month) only its months, without the sources and the closing line; `sourcesOnly`: those and
 * no months.
 */
export function heldLines(
  db: Database,
  ref: string,
  timeline: Dated[],
  { span, sourcesOnly }: { sourcesOnly?: boolean; span?: string } = {}
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
  const inSpan = units.filter((u) => !span || u.m.startsWith(span));
  const byPeriod = Map.groupBy(inSpan, (u) => u.m);
  const dated = timeline.filter((t) => !span || t.day.startsWith(span));
  const periods = [
    ...new Set([...byPeriod.keys(), ...dated.map((t) => t.day.slice(0, 7))]),
  ].sort();
  const count = (p: string, kind: Dated["kind"]) =>
    dated.filter((t) => t.kind === kind && t.day.startsWith(p)).length;
  const [first] = periods;
  const coverage = first
    ? readCoverage(
        db,
        `${first}-01`,
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
    ...(sourcesOnly
      ? []
      : [
          "By month (not seen, unknown: days a source of theirs was not captured, or Life cannot tell; never quiet days):",
          ...periods.map((p) => {
            const here = (byPeriod.get(p) ?? []).toSorted((a, b) => b.n - a.n);
            const by = [...Map.groupBy(here, (r) => r.source)]
              .sort((a, b) => total(b[1]) - total(a[1]))
              .map(([s, rows]) => `${s} ${total(rows)}`);
            return `- ${p}: ${total(here)} units${by.length > 0 ? ` (${by.join(", ")})` : ""}, ${count(p, "observation")} observations, ${count(p, "episode")} episodes${gapsOf(p)}`;
          }),
        ]),
    ...(span
      ? []
      : ["Not in Life: calls, and time together that wasn't recorded."]),
  ];
}

/** What a read says without reading the person: why it is no part, or the part `conversation` (his alone: the summary starting at the turn `span`). Null for any other. */
async function answeredEarly(
  name: string,
  o: { before?: string; part: string; span?: string },
  offered: readonly string[]
) {
  const bad = partErrorOf(o, offered);
  if (bad || o.part !== "conversation") {
    return bad ? [`(${bad})`] : null;
  }
  if (name !== OWNER.slice("person:".length)) {
    return ["(only person:me has conversation parts)"];
  }
  return (
    (await conversationSummaryPart(o.span as string)) ?? [
      "(no conversation summary starts at that turn)",
    ]
  );
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

/** The owner's `now` while his directory is new: a statement of fact, offering the setup interview. */
const NEW_DIRECTORY =
  "His directory is new: it holds only him, with no goals and no other people yet. What he says about his goals and how he plans to reach them, the main people in his life, his projects and areas of focus, and what Life may keep goes in through `change_directory_entry`, his words as `said`.";

/**
 * A person, read in parts (`read-part.ts`). `now`, the default: who they are to him and where things stand: candidates
 * when two people go by the name, their details, closeness, the last exchange, what is open between them, their
 * Situation and what their time together was about; then `page` (who they are, the page Life wrote), the parts an add-on
 * supplies (`personal`: `persona`, `story`, `year`, `month`, offered by the host while their add-on is on) and `evidence` (their
 * observations, episodes and recorded conversations, newest first by whole days, in a `span` and paged back by
 * `before`). Each part ends with its next reads, written by code. A name two people go by lists them, then reads the
 * first; a name on no page nor directory entry is looked for among lifelog's speakers, and someone only heard has no
 * parts (nothing to address them by): `now` shows their evidence, paged back with `before`; a name no one goes by
 * says so and lists the names near it.
 */
export async function person(
  name?: string,
  o: { before?: string; byId?: boolean; part?: string; span?: string } = {},
  personal: PersonalParts = {}
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
  const early = await answeredEarly(name, { before, part, span: o.span }, [
    ...READ_PARTS.filter((p) => !ADD_ON_PARTS.includes(p) || p in personal),
  ]);
  if (early) {
    return asData(early);
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
  let personalLines: PartInputs["personal"];
  try {
    personalLines = personal[part as ReadPart]?.build(ref);
  } catch (e) {
    // A part whose stored shape this version does not know: said, never read as empty.
    return asData([`(${(e as Error).message})`]);
  }
  const counted = now && partRef ? readExchangeCounts() : null;
  const rows = counted && { ...counted, rows: counted.people[ref] ?? [] };
  const items = now ? await readOpenItems(folks, clock()) : [];
  const style = now ? communicationStyleBlock(readCommunicationStyle(ref)) : [];
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
        lifelog ? [lifelog] : heard.map((s) => s.id),
        lifelogNames(truth)
      );
      // The lines of the parts that are one block, worked out for the one asked for only.
      const blocks: Record<string, () => string[]> = {
        now: () =>
          nowLines({
            after: situationBlock("Situation", readSituationNow(ref, live)),
            before: [
              ...(ref === OWNER && isDirectoryNew(truth)
                ? [NEW_DIRECTORY]
                : []),
              ...episodeTitleLines(episodes, (r) => refOf(r) === ref),
              ...detailsBlock(readDetailsOf(folks)(ref), dayNow()),
              ...closenessLine(ref, folks),
              ...lastExchangeLine(rows),
              ...style,
            ],
            open: (room) =>
              openWithOf(ref, {
                goals: goalProjects(truth.me.goals),
                items,
                room,
                today: dayNow(),
              }),
          }),
        page: () => pageBlock(db, found?.text ?? null, "in the evidence"),
      };
      return partLines({
        before,
        candidates: candidateLines(name, same, (who) => linkedCount(db, who)),
        fixed: partRef ? (blocks[part]?.() ?? []) : [],
        heard,
        held: (show) => heldLines(db, ref, timeline, show),
        heldYears: db
          .query<{ y: string }, [string]>(
            "select distinct substr(u.date, 1, 4) as y from unit_people p join units u on u.id = p.unit where p.person = ?"
          )
          .all(ref)
          .map((r) => r.y),
        offers: offersOf(personal),
        part: part as ReadPart,
        personal: personalLines,
        ref: partRef,
        span: o.span,
        timeline,
      });
    })
  );
}

/** About how many characters the next reads that end `now` take. */
const NEXT_READS_CHARS = 700;

/** The lines of `now`: what is open takes the room the rest leaves of `PART_CHARS`, less the next reads. */
export function nowLines(o: {
  after: string[];
  before: string[];
  open: (room: number) => string[];
}) {
  const used = [...o.before, ...o.after].join("\n").length;
  return [
    ...o.before,
    ...o.open(PART_CHARS - NEXT_READS_CHARS - used),
    ...o.after,
  ];
}

/** One timeline, newest first: the person's observations, episodes and recorded conversations. */
function timelineOf(
  db: Database,
  store: Parameters<typeof speakers>[0],
  ref: string,
  episodes: Episode[],
  voiceIds: string[],
  byId: Map<string, string>
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
    ...conversationsWith(store, voiceIds, byId).map((c) => ({
      day: localDate(c.start_at),
      kind: "conversation" as const,
      line: `- ${c.id} ${localDate(c.start_at)}: ${conversationLabel(c.start_at, c.names)}`,
    })),
  ].toSorted((a, b) => b.day.localeCompare(a.day));
}

/**
 * A part an add-on supplies (`personal/`), offered by the host only while that add-on is on. `build` runs before the
 * index opens (it may throw: said, never read as empty) and returns the part's lines; `about`, when there is one, is
 * what `now` says of it in its next reads.
 */
export interface PersonalPart {
  about?: string;
  build: (ref: string) => (o: PartInputs) => string[];
}
export type PersonalParts = Partial<Record<ReadPart, PersonalPart>>;

/** What `now` says of the parts an add-on supplies: those with something to say, in their order. */
export const offersOf = (personal: PersonalParts) =>
  Object.entries(personal).flatMap(([part, x]) =>
    x?.about ? [{ about: x.about, part: part as ReadPart }] : []
  );

/** What `partLines` is made from: the lines each part holds, and the dated entries it pages. */
export interface PartInputs {
  before?: string;
  candidates: string[];
  /** The lines of `now` or `page`, whichever is asked for. */
  fixed: string[];
  heard: { name: string }[];
  held: (o?: { sourcesOnly?: boolean; span?: string }) => string[];
  /** The years a unit of theirs is held in. */
  heldYears: string[];
  /** What `now` offers of the parts an add-on supplies. */
  offers: { about: string; part: ReadPart }[];
  part: ReadPart;
  /** The lines of the part asked for, when an add-on supplies it. */
  personal?: (o: PartInputs) => string[];
  ref?: string;
  span?: string;
  timeline: Dated[];
}

/** A next read of this person: `read-part.ts` writes it. */
export const readOf =
  (o: PartInputs) => (r: Omit<ReadPartRef, "subject">, what: string) => ({
    ref: { ...r, subject: o.ref as string },
    what,
  });
export type Read = ReturnType<ReturnType<typeof readOf>>;
export const ending = (reads: Read[]) => ["", ...nextReads(reads)];
const EVIDENCE =
  "their observations, episodes and recorded conversations, newest first";
export const evidenceRead = (o: PartInputs, span?: string): Read =>
  readOf(o)({ part: "evidence", span }, EVIDENCE);

/** The entries a part shows: newest first by whole days, as many as fit with its fixed lines (at least a day). */
export function paged(o: PartInputs, items: Dated[], fixed: string[]) {
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

/**
 * One part of a person's read, from what was gathered. `ref`: the person's ref, absent for someone only heard (their
 * `now` is the evidence, paged back with the older call: nothing can name a part). `fixed` holds the lines of
 * `now` or `page`; `timeline` the dated entries of `evidence` (and of the parts an add-on supplies); `held`, what Life holds by month or year. A part's dated entries stop at about `PART_CHARS`
 * with its fixed lines, a day never cut (`before`, a day, exclusive, pages back); each part ends with its next reads.
 */
export function partLines(o: PartInputs) {
  const read = readOf(o);
  if (o.part === "evidence" || !o.ref) {
    const { body, older } = evidenceLines(o);
    const held = o.part === "evidence" ? [] : ["", ...o.held()];
    return [...o.candidates, ...body, ...held, "", ...older];
  }
  switch (o.part) {
    case "now":
      return [
        ...o.candidates,
        ...o.fixed,
        ...ending([
          read({ part: "page" }, "who they are to him, as Life's page says"),
          ...o.offers.map((r) => read({ part: r.part }, r.about)),
          evidenceRead(o),
        ]),
      ];
    case "page":
      return [
        ...(o.fixed.length > 0 ? o.fixed : ["(no page yet)"]),
        ...ending([evidenceRead(o)]),
      ];
    default:
      return o.personal?.(o) ?? [];
  }
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

/** `heard`: the lifelog speakers a name on no page nor directory entry was found among. */
const recordedTitle = (heard: { name: string }[]) =>
  `Recorded conversations${heard.length > 0 ? ` with lifelog speakers named ${[...new Set(heard.map((s) => s.name))].join(", ")}` : ""} (\`fetch <id>\`):`;

export const orNone = (lines: string[]) =>
  lines.length > 0 ? lines : ["(none)"];

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
