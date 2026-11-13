import type { Episode } from "../records/episode";
import { entryLine, isListed, type LedgerEntry } from "../records/ledger-entry";
import { KEEP_AT, SEARCHABLE_AT } from "../records/unit";
import { lifelogMissing } from "../sources/lifelog";
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
import { episodesWhere, readBy, readLedger } from "./memory-files";
import { byTime, euros, paid, paymentLine, placedOn } from "./payments";
import { stayOf, staysOf, where } from "./places";
import { dueContext, dueOf } from "./read-open-items";
import { readPeople } from "./who";
import { inDays, localDate, time } from "./zones";

// `bun life memory day <date>` and the connector's `read_day`: what happened that day (its episodes), what is due, its
// units (recorded conversations among them), its key observations and what Life changed.

const DAY_FACTS = 15;

/** An episode of `read_day`: where he was during it (a stay, when lifelog says) and its key facts (`readBy`). */
export interface DayEpisode {
  episode: Episode;
  facts: string[];
  /** What was paid during it, in EUR, when payments are on and any was. */
  paid?: number;
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
  covered = [],
  due = [],
  facts = [],
  episodes = [],
  payments: paidLines = [],
  units = [],
  whereUnknown = false,
}: {
  actions?: readonly LedgerEntry[];
  born?: string[];
  covered?: SourceDay[];
  due?: string[];
  facts?: string[];
  episodes?: DayEpisode[];
  payments?: string[];
  units?: UnitRow[];
  whereUnknown?: boolean;
}) {
  // Worth nothing: a verdict below SEARCHABLE_AT (a unit with none yet is listed).
  const isNoise = (u: UnitRow) =>
    typeof u.importance === "number" && u.importance < SEARCHABLE_AT;
  const noise = units.filter(isNoise).length;
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
          ...episodes.flatMap(({ facts: of, episode, paid: spent, stay }) => [
            episodeLine(episode),
            ...(stay ? [`    Where he was: ${stay}`] : []),
            ...(spent ? [`    Paid: ${euros(spent)}`] : []),
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
    ...(paidLines.length > 0
      ? ["Payments (his accounts and wallet, in time order):", ...paidLines, ""]
      : []),
    `Units (${units.length}; \`fetch <unit id>\`${noise > 0 ? `; ${noise} worth nothing not listed` : ""}):`,
    ...units.filter((u) => !isNoise(u)).map(unitLine),
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
  const ofDays = await placedOn(date, date, all, stays ?? []);
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
      covered: readCoverage(db, date, date).days.get(date),
      due: dueOf(db, date, context),
      episodes: episodes.map((episode) => {
        const s = span(episode);
        const stay = s.allDay
          ? undefined
          : stays && stayOf(s.from, s.to, stays);
        const its = ofDays.list.filter((p) => p.episode === episode);
        return {
          episode,
          facts: factsOf(episode),
          ...(its.length > 0 ? { paid: paid(its) } : {}),
          stay: stay ? where(stay) : undefined,
        };
      }),
      facts: factsOf(undefined),
      payments: ofDays.error
        ? [`- Payments unknown: ${ofDays.error}`]
        : ofDays.list.toSorted(byTime).map(paymentLine),
      units: db
        .query<UnitRow, [string]>(
          "select id, date, source, title, topics, importance from units where date = ? order by source, title"
        )
        .all(date),
      whereUnknown: episodes.length > 0 && stays === null,
    });
  });
}
