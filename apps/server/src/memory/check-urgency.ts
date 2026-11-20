import type { CheckGroup } from "../core/names";
import { dayNow, localDate } from "./zones";

/** `blocks`: a worker waits on him, or Life cannot answer at all; `improves`: Life already uses its guess, or only asks. */
export type Urgency = "blocks" | "improves";

interface Rankable {
  group: CheckGroup;
  /** A voice's: the person lifelog suggests; null: none. `likelyPeople` ranks every profile, so it says nothing. */
  subject: string | null;
}

const RANK: Record<CheckGroup, number> = {
  "contacts card": 1,
  decision: 0,
  ending: 4,
  "guessed person": 2,
  name: 1,
  "new matter": 3,
  voice: 1,
};
/**
 * A check's kind, first to last: an agent's decision; a voice nobody has named, a name with no person or an ambiguous
 * Contacts card, mixed (these block); then a guess in use (a guessed person, a voice lifelog suggests a person for), a
 * new matter's offer, and last "is this done?". What blocks, and the inbox's order (`inboxOrderOf`), go by it.
 */
export const inboxRankOf = (c: Rankable) =>
  c.group === "voice" && c.subject !== null ? 2 : RANK[c.group];

const LAST_BLOCKING_RANK = 1;
export const urgencyOf = (c: Rankable): Urgency =>
  inboxRankOf(c) <= LAST_BLOCKING_RANK ? "blocks" : "improves";

interface Orderable extends Rankable {
  /** When it was asked (a decision's `at`), else its newest evidence. */
  day: string;
  deadline: string | null;
  matter: { id: string } | null;
  ref: string;
  ridesOn: {
    matterIds: string[];
    matters: number;
    observations: number;
    pages: number;
  };
}

const UNNAMED = 1;
const DECISION = 0;
const before = (a: Orderable, b: Orderable) =>
  Number(urgencyOf(a) === "improves") - Number(urgencyOf(b) === "improves") ||
  Number(b.deadline !== null) - Number(a.deadline !== null) ||
  (a.deadline ?? "").localeCompare(b.deadline ?? "") ||
  inboxRankOf(a) - inboxRankOf(b) ||
  (inboxRankOf(a) === DECISION
    ? a.day.localeCompare(b.day)
    : b.ridesOn.matters - a.ridesOn.matters ||
      (inboxRankOf(a) === UNNAMED
        ? 0
        : b.ridesOn.observations - a.ridesOn.observations ||
          b.ridesOn.pages - a.ridesOn.pages) ||
      b.day.localeCompare(a.day)) ||
  a.ref.localeCompare(b.ref);

const matterKeyOf = (c: Orderable) => {
  const id = c.matter?.id ?? c.ridesOn.matterIds[0];
  return id && `${urgencyOf(c)} ${id}`;
};

/**
 * His inbox's order, the one rule: what blocks, then what improves. In each, an ask with a deadline first, soonest
 * first; then by kind (`inboxRankOf`): decisions asked longest ago first; unnamed voices, names and cards by the matters
 * resting on them, then newest; the rest by matters, lines, pages, then newest. Then a matter's asks follow its first
 * one, in that order; an ask with no matter keeps its place.
 */
export const inboxOrderOf = <C extends Orderable>(list: C[]): C[] => {
  const sorted = list.toSorted(before);
  const ofMatter = Map.groupBy(sorted, matterKeyOf);
  const placed = new Set<string>();
  return sorted.flatMap((c) => {
    const key = matterKeyOf(c);
    if (!key) {
      return [c];
    }
    if (placed.has(key)) {
      return [];
    }
    placed.add(key);
    return ofMatter.get(key) ?? [];
  });
};

/** How many of `list` block him: the app's badge, and the one place to change what it counts. */
export const blockingCountOf = (list: Rankable[]) =>
  list.filter((c) => urgencyOf(c) === "blocks").length;

/** What the inbox holds: how many of each group, how many in all, how many block (the badge), and how many are due by the end of his day (`dayNow`). */
export const inboxOf = (list: (Rankable & { deadline: string | null })[]) => ({
  blocking: blockingCountOf(list),
  counts: Object.fromEntries(
    [...Map.groupBy(list, (c) => c.group)].map(([g, l]) => [g, l.length])
  ),
  deadlinesToday: list.filter(
    (c) => c.deadline && localDate(c.deadline) <= dayNow()
  ).length,
  total: list.length,
});
