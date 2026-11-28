import { isPromptVersion, readOwnerName } from "../models/prompt-parts";
import type { Episode } from "../records/episode";
import { entryLine, isListed, type LedgerEntry } from "../records/ledger-entry";
import {
  DAY_RECORD_READ,
  type DayRecord,
  type ReadReply,
} from "../records/read-reply";
import { KEEP_AT, SEARCHABLE_AT } from "../records/unit";
import { voiceServerMissing } from "../sources/voice-server-call";
import {
  currentSummaries,
  summaryLine,
  summaryRefOf,
} from "./conversation-summaries";
import { readCoverage, type SourceDay } from "./coverage";
import { BIRTHDAY_DAYS, readBirthdaysNear } from "./details";
import { span } from "./episode-span";
import {
  COLUMNS,
  CURRENT,
  episodeLine,
  line,
  type Row,
  type UnitRow,
  unitLine,
  withIndex,
} from "./index-rows";
import {
  episodesWhere,
  READ_REPLIES,
  readBy,
  readLedger,
} from "./memory-files";
import { type Mention, readMentionsOn, talkedAboutOf } from "./mentions";
import { byTime, euros, paid, paymentLine, placedOn } from "./payments";
import { stayOf, staysOf, where as whereOf } from "./places";
import { dueContext, dueOf } from "./read-open-items";
import { READS, readRepliesOfMonths } from "./read-replies";
import { tiesNow } from "./ties";
import { type People, placementOf, readPeople } from "./who";
import { asData } from "./words";
import { dayStart, inDays, localDate, time } from "./zones";

// `bun life memory day <date>` and the connector's `read_day`: what happened that day (its episodes), what is due, its
// units (recorded conversations among them), its key observations and what Life changed.

const DAY_FACTS = 15;

/** An episode of `read_day`: where he was during it (a stay, when the voice server says) and its key facts (`readBy`). */
export interface DayEpisode {
  episode: Episode;
  facts: string[];
  /** What was paid during it, in EUR, when payments are on and any was. */
  paid?: number;
  stay?: string;
  /** Who its units talked about without being in it (`talkedAboutOf`), by name. */
  talkedAbout?: string[];
}

/** A unit's episode among those shown (`readBy`'s pick), else undefined: its facts then sit under no episode. */
export const shownEpisode =
  (byEpisode: Map<string, Episode>, shown: Set<Episode>) => (unit: string) => {
    const m = byEpisode.get(unit);
    return m && shown.has(m) ? m : undefined;
  };

/**
 * The lines of `read_day`: the day's record when the night wrote one (`record`), the birthdays coming
 * (`birthdaysNear`), what is due that day (`dueOf`), what got done
 * (`doneOf`), what he did (its episodes in time order, each with where he was, what happened and its key facts), the
 * key facts in no episode, its units (conversations, chats, mail and the rest; those judged worth nothing only
 * counted; none shown when `units` is not given), then what Life changed for him.
 * `whereUnknown`: the voice server could not be read, so where he was is not shown.
 */
export function dayLines({
  actions = [],
  born = [],
  covered = [],
  done = [],
  due = [],
  facts = [],
  episodes = [],
  payments: paidLines = [],
  record,
  summaries = [],
  units,
  whereUnknown = false,
}: {
  actions?: readonly LedgerEntry[];
  born?: string[];
  covered?: SourceDay[];
  done?: string[];
  due?: string[];
  facts?: string[];
  episodes?: DayEpisode[];
  payments?: string[];
  /** The day's record as the night wrote it (`dayRecordLines`), shown first. */
  record?: string[];
  summaries?: string[];
  units?: UnitRow[];
  whereUnknown?: boolean;
}) {
  const owner = readOwnerName();
  // Worth nothing: a verdict below SEARCHABLE_AT (a unit with none yet is listed).
  const isNoise = (u: UnitRow) =>
    typeof u.importance === "number" && u.importance < SEARCHABLE_AT;
  const listed = units ?? [];
  const noise = listed.filter(isNoise).length;
  return [
    ...(record?.length
      ? ["Day record (written by Life the night after):", ...record, ""]
      : []),
    ...(born.length > 0
      ? [`Birthdays (this day and the next ${BIRTHDAY_DAYS}):`, ...born, ""]
      : []),
    ...(due.length > 0
      ? [
          `Due (open items, most pressing first: to-dos, promises and ${owner}'s to-do items for this day or up to a week overdue, waiting items on their day, undated ones and replies ${owner} owes the day after and 3 days after):`,
          ...due,
          "",
        ]
      : []),
    ...(done.length > 0
      ? ["Done (matters that ended this day, and how):", ...done, ""]
      : []),
    ...(episodes.length > 0
      ? [
          `Episodes (what ${owner} did, in time order):`,
          ...episodes.flatMap(
            ({ facts: of, episode, paid: spent, stay, talkedAbout }) => [
              episodeLine(episode),
              ...(stay ? [`    Where ${owner} was: ${stay}`] : []),
              ...(talkedAbout?.length
                ? [`    Talked about: ${talkedAbout.join(", ")}`]
                : []),
              ...(spent ? [`    Paid: ${euros(spent)}`] : []),
              ...(episode.what ? [`    ${episode.what}`] : []),
              ...of.map((f) => `    ${f}`),
            ]
          ),
          ...(whereUnknown
            ? [`Where ${owner} was is unknown: lifelog could not be read.`]
            : []),
          "",
        ]
      : []),
    ...(summaries.length > 0
      ? [
          "Conversation summaries (long conversations recorded in person, written from every line; `fetch <ref>` opens one):",
          ...summaries,
          "",
        ]
      : []),
    ...(facts.length > 0
      ? ["Key observations in no episode:", ...facts, ""]
      : []),
    ...(paidLines.length > 0
      ? [
          `Payments (${owner}'s accounts and wallet, in time order):`,
          ...paidLines,
          "",
        ]
      : []),
    ...(units
      ? [
          `Units (${units.length}; \`fetch <unit id>\`${noise > 0 ? `; ${noise} worth nothing not listed` : ""}):`,
          ...listed.filter((u) => !isNoise(u)).map(unitLine),
        ]
      : []),
    ...coveredLines(covered),
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

/**
 * A day's coverage as lines: which capturing sources were captured, which Life did not see (and why), which it cannot
 * tell. An empty list (no capturing source on) gives none.
 */
export function coveredLines(covered: SourceDay[]) {
  const named = (state: SourceDay["state"]) =>
    covered
      .filter((c) => c.state === state)
      .map((c) => `${c.label}${c.why ? ` (${c.why})` : ""}`)
      .join(state === "captured" ? ", " : "; ");
  const row = (title: string, state: SourceDay["state"]) =>
    named(state) ? [`- ${title}: ${named(state)}`] : [];
  return covered.length > 0
    ? [
        "",
        'Coverage (sources that capture on their own; "not seen" is not "quiet"):',
        ...row("Captured", "captured"),
        ...row("Not seen", "not_seen"),
        ...row("Unknown", "unknown"),
      ]
    : [];
}

/** The ids a day's lines rest on, for a day record's digest: never a name. */
export interface DayRefs {
  episodes: string[];
  facts: string[];
  payments: string[];
  summaries: string[];
}

/** Everything `dayLines` shows for one day, and the ids it rests on. */
export interface DayParts {
  actions: LedgerEntry[];
  born: string[];
  covered?: SourceDay[];
  done: string[];
  due: string[];
  episodes: DayEpisode[];
  facts: string[];
  payments: string[];
  refs: DayRefs;
  summaries: string[];
  units: UnitRow[];
  whereUnknown: boolean;
}

/** What many days' reads share: read once by a caller asking them all (`dayRecords`), else each is read. */
export interface DayShared {
  /** Every episode (`episodesWhere`), not only the day's. */
  all: Episode[];
  ledger: readonly LedgerEntry[];
  people: People;
}

/** Everything `dayLines` shows for `date`, with the ids it rests on; `shared` spares a caller asking many days. */
export async function readDayParts(
  date: string,
  shared?: DayShared
): Promise<DayParts | string> {
  const people = shared?.people ?? (await readPeople());
  const born = (await readBirthdaysNear(people, date)).map(
    (b) => `- ${b.name} (\`person ${b.id}\`): ${b.text}`
  );
  const actions = (shared?.ledger ?? readLedger()).filter(
    (a) => isListed(a) && localDate(a.at) === date
  );
  const all = shared?.all ?? (await episodesWhere(() => true));
  const episodes = all
    .filter(inDays({ from: date, to: date }))
    .toSorted((a, b) => (a.start ?? a.day).localeCompare(b.start ?? b.day));
  const byEpisode = readBy(all);
  // None without the voice server; null when it is set up but could not be read.
  const stays = voiceServerMissing()
    ? []
    : await staysOf({ at: date }).catch(() => null);
  const context = await dueContext(date, people);
  const mentions = readMentionsOn(date);
  const ties = tiesNow(people);
  const place = (m: Mention) => placementOf(m, people, ties)?.ref;
  const ofDays = await placedOn(date, date, all, stays ?? []);
  const held = (await currentSummaries()).filter(
    (h) => localDate(h.at) === date
  );
  return withIndex((db) => {
    const facts = db
      .query<Row & { unit: string }, [string]>(
        `select ${COLUMNS}, o.unit from observations o where o.date = ? and o.importance >= ${KEEP_AT} and ${CURRENT}
           order by o.importance desc, o.at limit ${DAY_FACTS}`
      )
      .all(date);
    const of = shownEpisode(byEpisode, new Set(episodes));
    const observationsOf = (m: Episode | undefined) =>
      facts.filter((f) => of(f.unit) === m).map(line);
    return {
      actions,
      born,
      covered: readCoverage(db, date, date).days.get(date),
      done: context.done,
      due: dueOf(date, context),
      episodes: episodes.map((episode) => {
        const s = span(episode);
        const stay = s.allDay
          ? undefined
          : stays && stayOf(s.from, s.to, stays);
        const its = ofDays.list.filter((p) => p.episode === episode);
        return {
          episode,
          facts: observationsOf(episode),
          ...(its.length > 0 ? { paid: paid(its) } : {}),
          stay: stay ? whereOf(stay) : undefined,
          talkedAbout: talkedAboutOf(
            episode,
            mentions,
            place,
            people.refOf
          ).map(people.nameOf),
        };
      }),
      facts: observationsOf(undefined),
      payments: ofDays.error
        ? [`- Payments unknown: ${ofDays.error}`]
        : ofDays.list.toSorted(byTime).map(paymentLine),
      refs: {
        episodes: episodes.map((e) => e.id),
        facts: facts.map((f) => f.id),
        payments: ofDays.list.map((p) => p.payment.id),
        summaries: held.map(summaryRefOf),
      },
      summaries: held.map(summaryLine),
      units: db
        .query<UnitRow, [string]>(
          "select id, date, source, title, topics, importance from units where date = ? order by source, title"
        )
        .all(date),
      whereUnknown: episodes.length > 0 && stays === null,
    };
  });
}

/** `read_day`: the day's lines, its record first when the night wrote one (`dayRecordLines`). */
export async function day(date: string) {
  const parts = await readDayParts(date);
  if (typeof parts === "string") {
    return parts;
  }
  const record = readDayRecord(date);
  return asData(
    dayLines({
      ...parts,
      ...(record ? { record: dayRecordLines(record.reply) } : {}),
    })
  );
}

type DayRecordLine = Extract<ReadReply, { read: typeof DAY_RECORD_READ }>;
const { prompt: DAY_RECORD_PROMPT } = READS.day_record;

/** The newest day record of each day, from the lines made by the read's current prompt (`isPromptVersion`). */
export function dayRecordsOf(lines: ReadReply[]) {
  const kept = new Map<string, DayRecordLine>();
  for (const reply of lines) {
    if (
      reply.read === DAY_RECORD_READ &&
      isPromptVersion(reply.madeBy.prompt, DAY_RECORD_PROMPT)
    ) {
      const held = kept.get(reply.day);
      if (!held || held.at < reply.at) {
        kept.set(reply.day, reply);
      }
    }
  }
  return kept;
}

/** A day's record: its newest line, read from the one month file it is filed in (its start's), never every year. */
export const readDayRecord = (date: string, where = READ_REPLIES) =>
  dayRecordsOf(
    readRepliesOfMonths(
      [dayStart(date).toISOString().slice(0, 7)],
      where
    ).flat()
  ).get(date);

/** A day's record as lines: its headline, its summary, then the people, projects, places and links it lists. */
export function dayRecordLines(r: DayRecord) {
  return [
    `- ${r.headline}`,
    r.summary,
    ...(r.people.length > 0
      ? [
          "",
          "People:",
          ...r.people.map(
            (p) => `- ${p.name}${p.ref ? ` (${p.ref})` : ""}: ${p.role}`
          ),
        ]
      : []),
    ...(r.projects.length > 0
      ? [
          "",
          "Projects:",
          ...r.projects.flatMap((p) => [
            `- ${p.project ?? "No project"}: ${p.what}`,
            ...(p.matters.length > 0
              ? [`    Matters: ${p.matters.join(", ")}`]
              : []),
          ]),
        ]
      : []),
    ...(r.places.length > 0
      ? [
          "",
          "Places:",
          ...r.places.map((p) => `- ${p.place}, ${p.from}-${p.to}`),
        ]
      : []),
    ...(r.links.length > 0
      ? ["", "Links:", ...r.links.map((l) => `- ${l.day}: ${l.what}`)]
      : []),
  ];
}
