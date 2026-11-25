import { daysBefore } from "../core/clock";
import type { CheckGroup } from "../core/names";
import { dayNow, localDate } from "./zones";

/** `blocks`: a registered agent waits on him, or Life cannot answer at all; `improves`: Life already uses its guess, or only asks. */
export type Urgency = "blocks" | "improves";

interface Rankable {
  /** His complaint on it at work with the caretaker: it then only improves. */
  beingFixed?: unknown;
  /** Its deadline: a your move card blocks only when it is due within `DUE_SOON_DAYS`. */
  deadline: string | null;
  group: CheckGroup;
  /** A voice's: the person lifelog suggests; null: none. `likelyPeople` ranks every profile, so it says nothing. */
  subject: string | null;
}

/**
 * What blocks (the badge): something broken that needs him (`fix`), an agent's decision, and what Life cannot answer at
 * all (a voice nobody has named, a name with no person, an ambiguous Contacts card); then his own step (`your move`), only
 * when due within `DUE_SOON_DAYS` (the cognitive-load rule of 22 Nov 2026). Never one the caretaker is at work on
 * (`beingFixed`). Everything else (Life's guesses in use, an offer) improves.
 */
const BLOCKING = new Set<CheckGroup>([
  "fix",
  "decision",
  "voice",
  "name",
  "contacts card",
  "your move",
]);
/** How many days ahead a your move card's deadline makes it block. */
const DUE_SOON_DAYS = 3;

const isMove = (c: Pick<Rankable, "group">) => c.group === "your move";

export const urgencyOf = (c: Rankable): Urgency =>
  BLOCKING.has(c.group) &&
  !(c.group === "voice" && c.subject !== null) &&
  !c.beingFixed &&
  (!isMove(c) ||
    (c.deadline !== null &&
      localDate(c.deadline) <= daysBefore(dayNow(), -DUE_SOON_DAYS)))
    ? "blocks"
    : "improves";

/** Whether a check shows in his inbox: every kind but an ending check, which shows on its matter's page (`checksOnMatterOf`): its link is Life's evidence, the step reads probably done until his word (the cognitive-load rule of 22 Nov 2026). */
export const isInboxCheck = (c: Pick<Rankable, "group">) =>
  c.group !== "ending";
/** Important: the gate read it high, or he marked its matter. */
const isImportant = (c: Orderable) =>
  c.importance === "high" || Boolean(c.matter?.important);

interface Orderable extends Rankable {
  /** When it was asked (a decision's `at`), a your move card's step's day, else its newest evidence. */
  day: string;
  /** An agent's card the gate read as high stakes. */
  importance?: "high";
  matter: { id: string; important?: boolean } | null;
  ref: string;
  ridesOn: { matterIds: string[] };
}

const before = (a: Orderable, b: Orderable) =>
  Number(Boolean(a.beingFixed)) - Number(Boolean(b.beingFixed)) ||
  Number(b.group === "fix") - Number(a.group === "fix") ||
  Number(b.deadline !== null) - Number(a.deadline !== null) ||
  (a.deadline ?? "").localeCompare(b.deadline ?? "") ||
  Number(!isImportant(a)) - Number(!isImportant(b)) ||
  a.day.localeCompare(b.day) ||
  a.ref.localeCompare(b.ref);

/** A matter's place among the asks: those the caretaker is fixing keep to their own group, never pulled ahead with its other asks. */
const matterKeyOf = (c: Orderable) => {
  const id = c.matter?.id ?? c.ridesOn.matterIds[0];
  return id && `${c.beingFixed ? "fixing " : ""}${id}`;
};

/**
 * His inbox's order, the one rule (the v4 plan, bundle E: no ranks by kind): what is broken first, then by deadline,
 * soonest first, then what is important (`isImportant`), then the longest waiting; the asks the caretaker is fixing
 * last. Then a matter's asks follow its first one; an ask with no matter keeps its place.
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
