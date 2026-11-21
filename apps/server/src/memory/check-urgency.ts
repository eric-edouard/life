import type { CheckGroup } from "../core/names";
import { dayNow, localDate } from "./zones";

/** `blocks`: a registered agent waits on him, or Life cannot answer at all; `improves`: Life already uses its guess, or only asks. */
export type Urgency = "blocks" | "improves";

interface Rankable {
  /** His complaint on it at work with the caretaker: it then only improves. */
  beingFixed?: unknown;
  group: CheckGroup;
  /** A voice's: the person lifelog suggests; null: none. `likelyPeople` ranks every profile, so it says nothing. */
  subject: string | null;
}

const RANK: Record<CheckGroup, number> = {
  "at organization": 4,
  "contacts card": 1,
  decision: 0,
  ending: 6,
  "guessed person": 4,
  name: 1,
  "new matter": 5,
  "same person": 3,
  voice: 1,
  "your move": 2,
};
/**
 * A check's kind, first to last: an agent's decision; a voice nobody has named, a name with no person or an ambiguous
 * Contacts card, mixed (these block); then his own step on a matter (`your move`); then one person Life holds twice
 * (`same person`: it bends every reader), then a guess in use (a guessed person, a voice lifelog suggests a person for, someone who may be at an organization), a
 * new matter's offer, and last "is this done?". What blocks, and the inbox's order (`inboxOrderOf`), go by it.
 */
export const inboxRankOf = (c: Rankable) =>
  c.group === "voice" && c.subject !== null
    ? RANK["guessed person"]
    : RANK[c.group];

const LAST_BLOCKING_RANK = RANK["your move"];
/** What blocks: by its kind (`inboxRankOf`), a your move card always (his word of 21 Nov 2026), unless the caretaker is at work on it (`beingFixed`). */
export const urgencyOf = (c: Rankable): Urgency =>
  inboxRankOf(c) <= LAST_BLOCKING_RANK && !c.beingFixed ? "blocks" : "improves";

/** A your move card: in its tier, last in the blocking tier, after every agent's decision and every other ask that blocks, whatever its mark or deadline; among them by deadline, then the longest waiting. */
const isMove = (c: Rankable) => c.group === "your move";
/** An ask of a matter he marked important, which goes first in its tier; never a your move card (they keep their own order). */
const isImportant = (c: Orderable) =>
  Boolean(c.matter?.important) && !isMove(c);

interface Orderable extends Rankable {
  /** When it was asked (a decision's `at`), a your move card's step's day, else its newest evidence. */
  day: string;
  deadline: string | null;
  matter: { id: string; important?: boolean } | null;
  ref: string;
  ridesOn: {
    matterIds: string[];
    matters: number;
    observations: number;
    pages: number;
  };
}

const before = (a: Orderable, b: Orderable) =>
  Number(urgencyOf(a) === "improves") - Number(urgencyOf(b) === "improves") ||
  Number(Boolean(a.beingFixed)) - Number(Boolean(b.beingFixed)) ||
  Number(isMove(a) && inboxRankOf(b) < RANK["your move"]) -
    Number(isMove(b) && inboxRankOf(a) < RANK["your move"]) ||
  Number(!isImportant(a)) - Number(!isImportant(b)) ||
  Number(b.deadline !== null) - Number(a.deadline !== null) ||
  (a.deadline ?? "").localeCompare(b.deadline ?? "") ||
  inboxRankOf(a) - inboxRankOf(b) ||
  (inboxRankOf(a) === RANK.decision || isMove(a)
    ? a.day.localeCompare(b.day)
    : b.ridesOn.matters - a.ridesOn.matters ||
      // Voices, names and cards share a rank: by matters, then newest only.
      (inboxRankOf(a) === RANK.name
        ? 0
        : b.ridesOn.observations - a.ridesOn.observations ||
          b.ridesOn.pages - a.ridesOn.pages) ||
      b.day.localeCompare(a.day)) ||
  a.ref.localeCompare(b.ref);

/** A matter's place among its tier's asks: those the caretaker is fixing, and its your move card, keep to their own group, never pulled ahead with its other asks. */
const matterKeyOf = (c: Orderable) => {
  const id = c.matter?.id ?? c.ridesOn.matterIds[0];
  return (
    id &&
    `${urgencyOf(c)}${c.beingFixed ? " fixing" : ""}${isMove(c) ? " move" : ""} ${id}`
  );
};

/**
 * His inbox's order, the one rule: what blocks, then what improves, the asks the caretaker is fixing last. In each, an ask of a matter he marked important
 * first; then an ask with a deadline, soonest first; then by kind (`inboxRankOf`): decisions asked longest ago first;
 * unnamed voices, names and cards by the matters resting on them, then newest; the rest by matters, lines, pages, then
 * newest. Then a matter's asks follow its first one, in that order; an ask with no matter keeps its place.
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
