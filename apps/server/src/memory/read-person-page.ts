import type { Database } from "bun:sqlite";
import { newestDays, within } from "../core/lists";
import { readOwnerName } from "../models/prompt-parts";
import type { Episode } from "../records/episode";
import { SubjectRef } from "../records/fields";
import { voiceHandleOf } from "../records/truth";
import { speakers, withStore } from "../sources/voice-server";
import { conversationsWith } from "../sources/voice-server-conversations";
import { noMatterChecksByPartyOf } from "./checks";
import { levelsWith, pagedNow } from "./closeness";
import { readCommunicationStyle } from "./communication-styles";
import { conversationSummaryPart } from "./conversation-summaries";
import { notCapturedOf, readCoverage } from "./coverage";
import { detailRefOf, detailsOf, readCardsOf } from "./details";
import { lastExchangeAtOf, readExchangeCounts } from "./exchange-counts";
import {
  episodeLine,
  latest,
  line,
  pageBlock,
  section,
  withIndex,
} from "./index-rows";
import { daysOf, pagePath } from "./memory-files";
import { slugOf } from "./page-format";
import { episodeTitlesOf } from "./person-episode-titles";
import { readEpisodesWith, readStandingEpisodes } from "./person-episodes";
import {
  isIn,
  isOnTheList,
  knowsOf,
  type NowInputs,
  type OpenNow,
  peopleListOf,
  personNowOf,
  reachPageOf,
  readLatest,
  rowOf,
  type Standing,
} from "./person-now";
import { reachOf, readSeenAccounts } from "./reach";
import {
  ADD_ON_PARTS,
  nextReads,
  PART_CHARS,
  partErrorOf,
  READ_PARTS,
  type ReadPart,
  type ReadPartRef,
} from "./read-part";
import { directoryPartiesOf, isDirectoryNew, OWNER } from "./read-truth";
import { readSituationNow } from "./situations";
import { conversationLabel, nameKey, voiceNames } from "./units";
import {
  meant,
  namedLike,
  nearNames,
  type People,
  personFor,
  readPeople,
} from "./who";
import { asData, holdsAll } from "./words";
import { dayNow, localDate } from "./zones";

// `bun life memory person [name]` and the connector's `read_people_and_organizations`: the people and organizations Life
// knows, and one of them: `now` and `latest` as data (`person-now.ts`), the page, what Life holds about them, their
// observations, episodes and recorded conversations, paged back by day.

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

/**
 * The people and organizations Life knows, and one of them read in parts (`read-part.ts`). With no name, the list
 * (`peopleListOf`): his directory's people and organizations and everyone with a page, ordered by closeness; with a
 * `query`, its matches and `others` (the people his Contacts name or Life inferred whose name is near it). With a
 * name, `now`, the default, as data (`personNowOf`): who they are to him, their reach, details, how each writes, what
 * their time together was about, their Situation, what is open with them (`matters`, from host) and the parts Life
 * holds; then the prose parts `page`, the parts an add-on supplies (`personal`: `persona`, `story`, `year`, `month`,
 * offered by the host while their add-on is on) and `evidence` (their observations, episodes and recorded
 * conversations, newest first by whole days, in a `span` and paged back by `before`), each ending with its next reads,
 * written by code; and `latest`, as data (`readLatest`). A name two people go by gives them as `candidates` with the
 * first's `now`; a name on no page nor directory entry is looked for among the voice server's speakers, and someone only heard
 * has no parts (nothing to address them by): `now` is their evidence (`heard`, paged back with `before`); a name no one
 * goes by says so (`noOne`) with the parties near it.
 */
export async function person(
  name?: string,
  o: {
    before?: string;
    byId?: boolean;
    part?: string;
    query?: string;
    span?: string;
  } = {},
  personal: PersonalParts = {},
  open: () => Promise<OpenNow> = () =>
    Promise.resolve({ checks: [], matters: [] })
): Promise<string | Record<string, unknown>> {
  if (!name) {
    return peopleList(await readPeople(), await open(), o.query);
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
  const id = known ?? slugOf(name);
  const ref = `person:${id}`;
  const partRef = personRefOf(known, id);
  if (part === "latest") {
    return partRef
      ? readLatest(partRef, before, folks)
      : asData(['(no part "latest" for someone only heard)']);
  }
  if (part === "reach") {
    return readReachPart(partRef, folks, o.span);
  }
  // The person's own page, by its id: never one whose file name only holds the name.
  const file = known && Bun.file(pagePath(`person:${known}`));
  const found =
    file && (await file.exists()) ? { text: await file.text() } : null;
  const mapped = truth.people.find((p) => p.id === id);
  const voicePersonId = voiceHandleOf(mapped?.handles);
  const episodes = await readEpisodesWith(ref, refOf);
  // What each part needs, read before the index opens (nothing awaits while it is).
  const isNow = part === "now" && !!partRef;
  // `now` builds only the parts it offers a preview of (`knows`).
  const asked = isNow ? offersOf(personal).map((x) => x.part) : [part];
  const built: PartInputs["personal"][] = [];
  try {
    for (const p of asked) {
      built.push(personal[p as ReadPart]?.build(ref));
    }
  } catch (e) {
    // A part whose stored shape this version does not know: said, never read as empty.
    return asData([`(${(e as Error).message})`]);
  }
  const personalOf = (p: string) => built[asked.indexOf(p)];
  const gathered = isNow
    ? nowGathered(
        ref,
        folks,
        await open(),
        // His own situation may cite any episode (his leave him out of their people): its cited ids, looked up.
        ref === OWNER ? readStandingEpisodes : episodes
      )
    : undefined;
  return withStore((store) => {
    // A name on no page nor directory entry: the voice server's speakers it is part of.
    const voices = speakers(store);
    const heard = known
      ? []
      : voices.filter((s) => nameKey(s.name).includes(nameKey(name)));
    if (!(known || heard.length > 0)) {
      return noOne(name, people, voices, folks.partyOf);
    }
    if (!partRef && part !== "now" && part !== "evidence") {
      return asData([
        `(no part "${part}" for someone only heard: read them with \`before\`)`,
      ]);
    }
    return withIndex<Record<string, unknown>>((db) => {
      const timeline = timelineOf(
        db,
        store,
        ref,
        episodes,
        voicePersonId ? [voicePersonId] : heard.map((s) => s.id),
        voiceNames(truth)
      );
      const page = () => pageBlock(db, found?.text ?? null, "in the evidence");
      const inputs: PartInputs = {
        before,
        fixed: part === "page" ? page() : [],
        heard,
        held: (show) => heldLines(db, ref, timeline, show),
        heldYears: heldYearsOf(db, ref),
        offers: offersOf(personal),
        part: part as ReadPart,
        personal: personalOf(part),
        ref: partRef,
        span: o.span,
        timeline,
      };
      if (!partRef) {
        return heardEvidence(inputs);
      }
      if (!gathered) {
        return partLines(inputs);
      }
      const more = {
        episodes: episodeTitlesOf(episodes, (r) => refOf(r) === ref),
        knows: knowsOf(nowReads(inputs), (p) =>
          knownLinesOf(p, inputs, page, personalOf)
        ),
      };
      if (same.length < 2) {
        return gathered(more, PART_CHARS);
      }
      // A shared name: the candidates (a quarter of the room at most; the list with `query` gives them all) wrap the first's `now`, which keeps to the room they leave.
      const all = same.map((p) => folks.partyOf(`person:${p.id}`));
      const candidates = within(
        all,
        PART_CHARS / 4,
        (x) => JSON.stringify(x).length + 1
      );
      const left = all.length - candidates.length;
      const wrapper = {
        candidates,
        ...(left > 0 ? { more: { candidates: left } } : {}),
      };
      const room = PART_CHARS - JSON.stringify({ ...wrapper, now: {} }).length;
      return { ...wrapper, now: gathered(more, room) };
    });
  });
}

/** The lines of one part `now` offers, for its first sentence (`knowsOf`). */
const knownLinesOf = (
  part: string,
  inputs: PartInputs,
  page: () => string[],
  personalOf: (part: string) => PartInputs["personal"]
) => {
  if (part === "page") {
    return page();
  }
  return part === "evidence"
    ? evidenceLines(inputs).body
    : (personalOf(part)?.(inputs) ?? []);
};

/** The years a unit of theirs is held in. */
const heldYearsOf = (db: Database, ref: string) =>
  db
    .query<{ y: string }, [string]>(
      "select distinct substr(u.date, 1, 4) as y from unit_people p join units u on u.id = p.unit where p.person = ?"
    )
    .all(ref)
    .map((r) => r.y);

/** What `now` reads of one person before the index opens, as a function of what the index adds (episodes, knows). */
function nowGathered(
  ref: string,
  people: People,
  { checks, matters }: OpenNow,
  standing: Parameters<typeof readSituationNow>[1]
) {
  const { truth } = people;
  const asks =
    noMatterChecksByPartyOf(checks, people.canon).get(people.canon(ref)) ?? [];
  const row = rowOf(
    people.partyOf(ref),
    standingOf(levelsWith(people), readExchangeCounts()),
    matters,
    asks.length > 0
  );
  const organization = truth.organizations.find(
    (x) => `person:${x.id}` === ref
  );
  // His Contacts read once, for reach and details.
  const cards = readCardsOf(people)(ref);
  const reach = readReachOf(ref, people, cards);
  const details = detailsOf({
    contacts: cards,
    person: truth.people.find((p) => `person:${p.id}` === ref),
    refOf: detailRefOf(people),
  });
  const theirs = matters.filter((m) => isIn(m, ref));
  return (more: Pick<NowInputs, "episodes" | "knows">, chars: number) =>
    personNowOf(
      {
        ...more,
        checks: asks,
        communicationStyle: readCommunicationStyle(ref),
        details,
        ...(ref === OWNER && isDirectoryNew(truth)
          ? { directoryIsNew: true as const }
          : {}),
        matters: theirs,
        pictures: people.pictureChoicesOf(row.ref),
        ...(organization
          ? {
              organization: {
                domains: organization.domains,
                people: organization.people.map((p) => ({
                  party: people.partyOf(`person:${p.id}`),
                  role: p.role,
                  ...(p.until === undefined ? {} : { until: p.until }),
                })),
              },
            }
          : {}),
        reach,
        row,
        situation: readSituationNow(ref, standing, people.refOf),
        today: dayNow(),
      },
      chars
    );
}

/** Every account `ref` is reached on, as `reachOf` works them out from his directory, Contacts (`cards`) and their chats. */
const readReachOf = (
  ref: string,
  people: People,
  cards = readCardsOf(people)(ref)
) =>
  reachOf({
    cards,
    party: directoryPartiesOf(people.truth).find(
      (p) => `person:${p.id}` === ref
    ),
    seen: readSeenAccounts(ref),
  });

/** `reach`: every account of a person Life knows, from the `span`th on (`reachPageOf`), and the ref of the next page. */
function readReachPart(
  partRef: string | undefined,
  people: People,
  span = "0"
) {
  if (!partRef) {
    return asData(['(no part "reach" for someone only heard)']);
  }
  return reachPageOf(readReachOf(partRef, people), Number(span), partRef);
}

/** Each ref's levels and last exchange, from what the caller read once. */
const standingOf = (
  levels: ReturnType<typeof levelsWith>,
  counted: ReturnType<typeof readExchangeCounts>
): Standing => ({
  lastExchangeAt: lastExchangeAtOf(counted),
  levelOf: (ref) => levels.get(ref),
});

/**
 * The list (no name): his directory's people and organizations and everyone with a page, each once as they read
 * today, him left out, ordered by closeness (`peopleListOf`). With a `query`: those whose name or alias holds its
 * words or is near it, and `others`, the people near it his Contacts name or Life inferred.
 */
async function peopleList(
  people: People,
  { checks, matters }: OpenNow,
  query?: string
) {
  const { canon, truth } = people;
  const directory = directoryPartiesOf(truth);
  const refs = new Set(
    [
      ...directory.map((p) => canon(`person:${p.id}`)),
      ...(await pagedNow(people)),
    ].filter(isOnTheList)
  );
  const standing = standingOf(levelsWith(people), readExchangeCounts());
  const asks = noMatterChecksByPartyOf(checks, canon);
  const rowsOf = (list: Iterable<string>) =>
    peopleListOf(
      [...list].map((ref) =>
        rowOf(people.partyOf(ref), standing, matters, asks.has(ref))
      )
    );
  if (!query) {
    return { people: rowsOf(refs) };
  }
  const holds = holdsAll(query);
  const aliases = new Map(
    directory.map((p) => [canon(`person:${p.id}`), p.aliases])
  );
  const near = people.candidatesFor(query);
  const matched = [...refs].filter(
    (ref) =>
      near.includes(ref) ||
      [people.nameOf(ref), ...(aliases.get(ref) ?? [])].some(holds)
  );
  return {
    others: [...new Set(near)]
      .filter((ref) => !refs.has(ref) && isOnTheList(ref))
      .map(people.partyOf),
    people: rowsOf(matched),
  };
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
  /** The lines of `page`, when it is asked for. */
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
    next,
    older: next ? older : ["(nothing older)"],
  };
}

/** The reads `now` offers: who they are (the page), the parts an add-on supplies, and the evidence; `knows` is made of them. */
export const nowReads = (o: PartInputs) => [
  readOf(o)(
    { part: "page" },
    `who they are to ${readOwnerName()}, as Life's page says`
  ),
  ...o.offers.map((r) => readOf(o)({ part: r.part }, r.about)),
  evidenceRead(o),
];

/**
 * One prose part of a person's read, from what was gathered. `fixed` holds the lines of `page`; `timeline` the dated
 * entries of `evidence` (and of the parts an add-on supplies); `held`, what Life holds by month or year. A part's
 * dated entries stop at about `PART_CHARS` with its fixed lines, a day never cut (`before`, a day, exclusive, pages
 * back); each part ends with its next reads.
 */
export function partLines(o: PartInputs) {
  if (o.part === "evidence") {
    const { body, older } = evidenceLines(o);
    return [...body, "", ...older];
  }
  if (o.part === "page") {
    return [
      ...(o.fixed.length > 0 ? o.fixed : ["(no page yet)"]),
      ...ending([evidenceRead(o)]),
    ];
  }
  return o.personal?.(o) ?? [];
}

/** Someone only heard, as data: who they were heard as, their evidence and what Life holds, paged back with `before`. */
export function heardEvidence(o: PartInputs) {
  const { body, next } = evidenceLines(o);
  return {
    evidence: [...body, "", ...o.held()],
    heard: [...new Set(o.heard.map((h) => h.name))].map((n) => ({ name: n })),
    ...(next ? { nextBefore: next } : {}),
  };
}

/** `heard`: the voice server's speakers a name on no page nor directory entry was found among. */
const recordedTitle = (heard: { name: string }[]) =>
  `Recorded conversations${heard.length > 0 ? ` with the voice server's speakers named ${[...new Set(heard.map((s) => s.name))].join(", ")}` : ""} (\`fetch <id>\`):`;

export const orNone = (lines: string[]) =>
  lines.length > 0 ? lines : ["(none)"];

/**
 * A name no one goes by, as data: the name, and who it is near (`nearNames`; the voice server's speakers too, but one already on
 * the list is that person): a party where Life has a ref, else the name as heard.
 */
function noOne(
  name: string,
  people: { aliases: string[]; id: string; name: string }[],
  heard: { name: string }[],
  partyOf: People["partyOf"]
) {
  const near = nearNames(name, [
    ...people.map((p) => ({ ...p, isHeard: false })),
    ...heard
      .filter((s) => namedLike(s.name, people).length === 0)
      .map((s) => ({ aliases: [], id: s.name, isHeard: true, name: s.name })),
  ]);
  return {
    near: near.map((p) =>
      p.isHeard ? { name: p.name } : partyOf(`person:${p.id}`)
    ),
    noOne: name,
  };
}
