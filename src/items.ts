import { type Action, type SourceEvent, stands } from "./schema";

// Open items (Stage 4b, his request of 21 Oct): everything someone still has to do is Life's own state, derived on
// every read from the records that already hold each fact (the observations, memory/actions.jsonl, his chats), never
// stored, ranked by code. Reminders is one interface to it: delete src/sync.ts and this still holds.

// His reminders as the ledger holds them: what Life wrote (`act`, its intents too) and what it read back as his
// (`madeBy: "reminders"`, src/sync.ts), walked in order.

/** What `inbound` compares. `lost`: neither in his lists nor in Recently Deleted (purged, or moved to a shared list). */
export const FIELDS = [
  "completed",
  "deleted",
  "due",
  "flagged",
  "list",
  "lost",
  "notes",
  "priority",
  "title",
  "urgent",
] as const;
export type Fields = Partial<Record<(typeof FIELDS)[number], unknown>>;
/** One value per meaning: null, false, "" and "none" all mean not set. */
export const norm = (v: unknown) =>
  v === null || v === false || v === "" || v === "none" ? undefined : v;
export const pick = (o: Record<string, unknown>): Fields =>
  Object.fromEntries(FIELDS.flatMap((f) => (f in o ? [[f, norm(o[f])]] : [])));

export type Field = (typeof FIELDS)[number];

/** A reminder Life links: the line that opened it (`key`: Life's id for it, `at`, the observation or words it came from), its id in Reminders now, what Life left on it. */
export interface Linked {
  at: string;
  fields: Fields;
  id: number;
  key: string;
  link?: string;
  ref?: string;
  /** When it was last removed (to Recently Deleted), by Life or by him. */
  removedAt?: string;
  tried: Map<string, unknown[]>;
  /** When Life last wrote to it or tried to (src/sync.ts waits out Reminders' lag after it). */
  wrote?: string;
}

/**
 * One line's mark on a linked reminder: a try adds its values to `tried`, and so does a partial (a step failed, which
 * one is unknown: the next pass learns what is there); a write that went through, or his change seen, settles them.
 */
function apply(it: Linked, a: Action) {
  const after = pick(a.after);
  // An intent or a failure: its outcome is not known to stand.
  const tried = !stands(a);
  const unsure = tried || Boolean(a.error?.startsWith("partial"));
  it.wrote = a.madeBy === "reminders" ? it.wrote : a.at;
  for (const [f, v] of Object.entries(after)) {
    if (unsure) {
      it.tried.set(f, [...(it.tried.get(f) ?? []), v]);
    } else {
      it.fields[f as Field] = v;
      it.tried.delete(f);
    }
  }
  if (!tried) {
    it.link = (a.after.link as string | undefined) ?? it.link;
    it.removedAt = after.deleted ? a.at : it.removedAt;
  }
  return tried;
}

/** Every reminder Life links, by its id now: what the ledger says Life left on it, and the values Life tried since each settled. */
export function linked(actions: Action[]) {
  const items = new Map<number, Linked>();
  for (const a of actions) {
    const n = Number(a.target.split(":")[1]);
    // A move can give a new id (`edit` in src/sync.ts): the line's `before` has the old one.
    const from = typeof a.before?.id === "number" ? a.before.id : n;
    const opens =
      (a.kind === "add" || a.kind === "import") && a.result === "ok";
    const it: Linked | undefined =
      items.get(from) ??
      (opens
        ? {
            at: a.at,
            fields: {},
            id: n,
            key: a.id,
            ref: a.instruction?.ref,
            tried: new Map(),
          }
        : undefined);
    if (
      it &&
      a.target.startsWith("reminder:") &&
      a.result !== "duplicate" &&
      !apply(it, a)
    ) {
      items.delete(from);
      items.set(n, it);
      it.id = n;
    }
  }
  return items;
}

/** His reminders still open, as the ledger holds them: not ticked, not removed, not lost. */
export const openLinked = (actions: Action[]) =>
  [...linked(actions).values()].filter(
    ({ fields: f }) => !(f.completed || f.deleted || f.lost)
  );

// The view: what `day` lists as due (src/memory/search.ts gathers the candidates, each with its line). Copies merge,
// timing decides when an item shows, rank decides the order; no model writes either, and nothing is stored.

/** One candidate open item, with the line `day` shows for it. */
export interface Candidate {
  /** When it was said or made: older first at the same rank. */
  at: string;
  /** Life's id: an observation's, a reminder's add (`act_`), a chat message's. */
  id: string;
  kind: "promise" | "reminder" | "reply" | "todo" | "waiting";
  line: string;
  /** A reminder made from an observation (the grant's): the two are one item. */
  obs?: string;
  /** Who it is with, for the rank: their closeness, inner first. */
  person?: string;
  priority?: string;
  projects?: string[];
  /** The turn it was said in: an open task from the same turn holds it (it is on the board). */
  ref?: string;
  urgent?: boolean;
  /** Its day. A reply's is when the last word, theirs, was sent. */
  when?: string;
}
export type OpenItem = Candidate & { merged: string[]; overdue: boolean };

/** How many days late a dated item is still listed, labelled, so a missed daily review is caught up. */
export const OVERDUE_DAYS = 7;

const DAY_MS = 86_400_000;
const daysFrom = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

/**
 * Whether an item shows on `date`, each at most twice: a dated one on its day (the daily review reads tomorrow too, so
 * the day before as well), then, only if a review never showed it twice (`shown`), up to `OVERDUE_DAYS` late; a
 * waiting one on its day; a reply he owes the day after their last word and 3 days after. Undated ones wait for
 * Stage 4's re-read (the review's PR 2).
 */
function timely(c: Candidate, date: string, today: string, shown: number) {
  if (!c.when) {
    return false;
  }
  const late = daysFrom(c.when, date);
  if (c.kind === "reply") {
    // Only as its days come: the review reads tomorrow too, which would show it four times.
    return (late === 1 || late === 3) && date <= today;
  }
  if (c.kind === "waiting") {
    return late === 0;
  }
  return late === 0 || (late > 0 && late <= OVERDUE_DAYS && shown < 2);
}

const PRIORITY = ["high", "medium", "low"];
/** Who owes whom: a reply he owes and his promise first, owed to him last (he can only chase it). */
const KIND = { promise: 0, reminder: 1, reply: 0, todo: 1, waiting: 2 };

/**
 * The open items due on `date`, ranked: his urgent flag, then his priority; who owes whom; the first of his goals it
 * serves (`goals`: each goal's project ids, his order); closeness to whoever it is with (`levels`: 0 inner); older
 * first. Copies merge: a reminder into the observation it came from, and an item said in the turn of an open task
 * (`tasks`: their refs) is left to that task. `shown`: on how many days a daily review was already shown each id.
 */
export function openItems(
  candidates: Candidate[],
  {
    date,
    goals = [],
    levels = new Map(),
    shown = new Map(),
    tasks = new Set(),
    today = date,
  }: {
    date: string;
    goals?: string[][];
    levels?: Map<string, number>;
    shown?: Map<string, number>;
    tasks?: Set<string>;
    /** His day now: what the review reads ahead of it is shown no reply. */
    today?: string;
  }
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
    .filter(
      (c) =>
        !(c.ref && tasks.has(c.ref)) &&
        timely(c, date, today, shown.get(c.id) ?? 0)
    )
    .map((c) => ({
      ...c,
      overdue: (c.when ?? date) < date && c.kind !== "reply",
    }))
    .toSorted(rank);
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
