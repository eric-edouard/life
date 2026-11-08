import { DAY } from "../core/clock";
import type { SourceEvent } from "../records/source";

// Open items (Stage 4b, his request of 21 Oct): everything someone still has to do is Life's own state, derived on
// every read from the records that already hold each fact (the observations, memory/ledger.jsonl, his chats), never
// stored, ranked by code. The actions backend is one interface to it: without one this still holds.

// The view: what `read_day` lists as due (apps/server/src/memory/search.ts gathers the candidates, each with its line). Copies merge,
// timing decides when an item shows, rank decides the order; no model writes either, and nothing is stored.

/** One candidate open item, with the line `read_day` shows for it. */
export interface Candidate {
  /** When it was said or made: older first at the same rank. */
  at: string;
  /** Life's id: an observation's, a reminder's add (`entry_`), a chat message's. */
  id: string;
  kind: "promise" | "reminder" | "reply" | "to_do" | "waiting_on_someone";
  line: string;
  /** A reminder made from an observation (the grant's): the two are one item. */
  obs?: string;
  /** Who it is with, for the rank: their closeness, inner first. */
  person?: string;
  priority?: string;
  projects?: string[];
  /** The day it was said, for one with no day of its own (an undated to-do, promise or wait; a reply he owes: their last word). */
  said?: string;
  urgent?: boolean;
  /** Its day, when it has one. */
  when?: string;
}
export type OpenItem = Candidate & { merged: string[]; overdue: boolean };

/** When an item said with no day of its own is shown again, after the day after. */
export const AGAIN_DAYS = 3;

/** How many days late a dated item is still listed, labelled, so a missed daily review is caught up. */
export const OVERDUE_DAYS = 7;

const daysFrom = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY);

/**
 * Whether an item shows on `date`, each at most twice: a dated one on its day (the daily review reads tomorrow too, so
 * the day before as well), then, only if a review never showed it twice (`shown`), up to `OVERDUE_DAYS` late; a
 * waiting one on its day; one said with no day (an undated to-do, promise or wait, a reply he owes) the day after
 * and 3 days after.
 */
function timely(c: Candidate, date: string, today: string, shown: string[]) {
  const { when } = c;
  if (!when) {
    // Said with no day of its own: the day after and `AGAIN_DAYS` after, only as those days come (the review reads
    // tomorrow too); then stale, never due again.
    const late = c.said ? daysFrom(c.said, date) : Number.NaN;
    return (late === 1 || late === AGAIN_DAYS) && date <= today;
  }
  const late = daysFrom(when, date);
  if (c.kind === "waiting_on_someone") {
    return late === 0;
  }
  // Shown in Due: on a day from the one before its day (its ids elsewhere in `read_day` don't count).
  const inDue = shown.filter((d) => daysFrom(d, when) <= 1).length;
  return (
    late === 0 ||
    (late > 0 && late <= OVERDUE_DAYS && inDue < 2 && date <= today)
  );
}

const PRIORITY = ["high", "medium", "low"];
/** Who owes whom: a reply he owes and his promise first, owed to him last (he can only chase it). */
const KIND = {
  promise: 0,
  reminder: 1,
  reply: 0,
  to_do: 1,
  waiting_on_someone: 2,
};

/** Owed to him (he can only chase it); every other open item is his to do, a promise included (decision 11b). */
export const isOwedToHim = (c: Candidate) => c.kind === "waiting_on_someone";

/**
 * Every open item, ranked: his urgent flag, then his priority; who owes whom; the first of his goals it serves
 * (`goals`: each goal's project ids, his order); closeness to whoever it is with (`levels`: 0 inner); older first.
 * Copies merge: a reminder into the observation it came from. Overdue: its day is before `date`.
 */
export function rankedItems(
  candidates: Candidate[],
  {
    date,
    goals = [],
    levels = new Map(),
  }: { date: string; goals?: string[][]; levels?: Map<string, number> }
): OpenItem[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const items = new Map<string, OpenItem>();
  for (const c of candidates) {
    const into = c.obs ? byId.get(c.obs) : undefined;
    if (!into) {
      items.set(c.id, { ...c, merged: [], overdue: false });
    }
  }
  for (const c of candidates) {
    const it = c.obs ? items.get(c.obs) : undefined;
    if (it) {
      it.merged.push(c.id);
      it.urgent ||= c.urgent;
      it.priority ??= c.priority;
      // A reminder with a due date gives an undated observation its day.
      it.when ??= c.when;
    }
  }
  const goal = (c: Candidate) => {
    const g = goals.findIndex((ids) =>
      ids.some((p) => c.projects?.includes(p))
    );
    return g < 0 ? goals.length : g;
  };
  const key = (c: OpenItem): number[] => [
    c.urgent ? 0 : 1,
    c.priority && PRIORITY.includes(c.priority)
      ? PRIORITY.indexOf(c.priority)
      : PRIORITY.length,
    KIND[c.kind],
    goal(c),
    (c.person ? levels.get(c.person) : undefined) ?? 4,
  ];
  const rank = (a: OpenItem, b: OpenItem) => {
    const [x, y] = [key(a), key(b)];
    const i = x.findIndex((v, k) => v !== y[k]);
    return i < 0 ? a.at.localeCompare(b.at) : (x[i] ?? 0) - (y[i] ?? 0);
  };
  return [...items.values()]
    .map((c) => ({ ...c, overdue: (c.when ?? date) < date }))
    .toSorted(rank);
}

/**
 * The open items due on `date` (`timely`), ranked (`rankedItems`). `shown`: the days a daily review was already given
 * each id (`read_day`'s answers).
 */
export function openItems(
  candidates: Candidate[],
  {
    shown = new Map(),
    today,
    ...rank
  }: Parameters<typeof rankedItems>[1] & {
    shown?: Map<string, string[]>;
    /** His day now: what the review reads ahead of it shows no undated item. */
    today?: string;
  }
) {
  return rankedItems(candidates, rank).filter((c) =>
    timely(c, rank.date, today ?? rank.date, shown.get(c.id) ?? [])
  );
}

/**
 * The 1:1 chats whose last word is theirs (audit 5, the glazier): of each chat with words in `events` (oldest first, his
 * last 60 days), the last message, when it is theirs and he wrote in that chat. `direct`: whether it is 1:1
 * (`isDirect`), never a name; an empty line (a system line) is no word.
 */
export function owed(
  events: SourceEvent[],
  direct: (e: SourceEvent, others: number) => boolean
) {
  const out: SourceEvent[] = [];
  for (const list of Map.groupBy(
    events,
    (e) => `${e.source}:${e.chat}`
  ).values()) {
    // A file alone (a photo, a voice note) is a word too.
    const said = list.filter((e) => e.text.trim() || e.files?.length);
    const last = said.at(-1);
    const others = new Set(said.filter((e) => !e.fromMe).map((e) => e.sender));
    if (
      last &&
      !last.fromMe &&
      said.some((e) => e.fromMe) &&
      direct(last, others.size)
    ) {
      out.push(last);
    }
  }
  return out;
}
