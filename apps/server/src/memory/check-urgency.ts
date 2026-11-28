import { daysBefore } from "../core/clock";
import type { CheckGroup, Level } from "../core/names";
import { dayNow, localDate } from "./zones";

/** `blocks`: a registered agent waits on him, or Life cannot answer at all; `improves`: Life already uses its guess, or only asks. */
export type Urgency = "blocks" | "improves";

interface Rankable {
  /** His complaint on it at work with the caretaker: it then only improves. */
  beingFixed?: unknown;
  deadline: string | null;
  group: CheckGroup;
  /** A your move card's: whether it blocks him (`askOfStep`). */
  isBlocking?: boolean;
  /** A your move card's: whether it is on its matter's page only (`askOfStep`). */
  isHidden?: boolean;
}

/**
 * What blocks (the badge): something broken that needs him (`fix`), an agent's decision, and what Life cannot answer at
 * all (a name with no person, an ambiguous Contacts card); then his own step (`your move`), only when `askOfStep` says
 * it blocks. Never one the caretaker is at work on (`beingFixed`). Everything else (a voice to name, his yes of
 * 26 Nov 2026 to "Voices to name"; Life's guesses in use, an offer) improves.
 */
const BLOCKING = new Set<CheckGroup>([
  "fix",
  "decision",
  "name",
  "contacts card",
  "your move",
]);

const isMove = (c: Pick<Rankable, "group">) => c.group === "your move";

export const urgencyOf = (c: Rankable): Urgency =>
  BLOCKING.has(c.group) && !c.beingFixed && (!isMove(c) || c.isBlocking)
    ? "blocks"
    : "improves";

/** What `askOfStep` reads of a step's readings (`step-readings.ts`): the model's, never a verdict. */
export interface StepAskReadings {
  /** The `what-to-ask` instruction the reading cites as deciding, by id; null: none. */
  by: string | null;
  handledBy: "owner" | "owner_elsewhere" | "someone_else";
  money: "none" | "some" | "due_on_receipt";
  urgency: Level;
}

/** What `askOfStep` reads of the step itself: code's facts, never the model's. */
export interface StepAskFacts {
  /** Its due day (a whole date), past or ahead; none: no due day. */
  due?: string;
  /** The day it was first noted. */
  first: string;
  /** A promise made with a person. */
  isPromiseToPerson: boolean;
}

/**
 * Whether his open step is asked, the one rule (his words of 28 Nov 2026), pure: hidden (on its matter's page only) when
 * its reading's `by` is a `what-to-ask` instruction in force on it (`inForce`), or, for a step not protected, when it is
 * not his to do here (`handledBy`: his own work done elsewhere, or someone else's). A promise with a person, any due
 * day or money (`money`) protects it: only his words hide it then. Not hidden, it blocks when the reading is urgent,
 * when it is due within 3 days, or when it is money due on receipt with no due day, first noted a week ago or more.
 * No reading: never hidden, blocking only by its due day.
 */
export function askOfStep(
  r: StepAskReadings | undefined,
  f: StepAskFacts,
  inForce: ReadonlySet<string>,
  today: string
) {
  const isProtected =
    f.isPromiseToPerson || f.due !== undefined || (r && r.money !== "none");
  const isHidden = Boolean(
    (r?.by && inForce.has(r.by)) ||
      (!isProtected && r && r.handledBy !== "owner")
  );
  const isBlocking =
    !isHidden &&
    (r?.urgency === "high" ||
      (f.due !== undefined && f.due <= daysBefore(today, -3)) ||
      (r?.money === "due_on_receipt" &&
        f.due === undefined &&
        f.first <= daysBefore(today, 7)));
  return { isBlocking, isHidden };
}

/** Whether a check shows in his inbox: every kind but an ending check, which shows on its matter's page (`checksOnMatterOf`): its link is Life's evidence, the step reads probably done until his word (the cognitive-load rule of 22 Nov 2026); nor a your move card `askOfStep` hides. */
export const isInboxCheck = (c: Pick<Rankable, "group" | "isHidden">) =>
  c.group !== "ending" && !c.isHidden;
/** Important: the gate read it high, or he marked its matter. */
const isImportant = (c: Orderable) =>
  c.importance === "high" || Boolean(c.matter?.important);

interface Orderable extends Rankable {
  /** When it was asked (a decision's `at`), a your move card's step's day, else its newest evidence. */
  day: string;
  /** An agent's card the gate read as high stakes. */
  importance?: "high";
  matter: { id: string; important?: boolean } | null;
  /** A your move card's matter's place in his ranking (`rankedMattersOf`); none: after every ranked one. */
  matterRank?: number;
  ref: string;
  ridesOn: { matterIds: string[] };
}

/** Two your move cards: by their matters' place in his ranking (regression cases stack-2 and stack-3: his ranking beats a deadline and age); any other pair ties. */
const byMatterRank = (a: Orderable, b: Orderable) =>
  isMove(a) && isMove(b)
    ? (a.matterRank ?? Number.MAX_SAFE_INTEGER) -
      (b.matterRank ?? Number.MAX_SAFE_INTEGER)
    : 0;

const before = (a: Orderable, b: Orderable) =>
  Number(Boolean(a.beingFixed)) - Number(Boolean(b.beingFixed)) ||
  Number(b.group === "fix") - Number(a.group === "fix") ||
  byMatterRank(a, b) ||
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
 * soonest first, then what is important (`isImportant`), then the longest waiting (two your move cards: his ranking of
 * their matters first, `byMatterRank`); the asks the caretaker is fixing
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
