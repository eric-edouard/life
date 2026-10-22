import { isOn, off } from "../outputs";
import type { Action } from "../schema";
import { agentName, settings } from "../settings";
import type { Change } from "./act";
import { google } from "./google";
import { reminders } from "./remctl";

// The actions output: one contract, two backends, one per install (the `actions` setting): Apple Reminders through
// remctl (`remctl.ts`), Google Tasks through gog (`google.ts`). Nothing else touches either. A backend is how a change
// is written and read back, never the truth: `act` decides each change and `write` (here) makes it, `board.ts`
// projects the agent's tasks, `inbound.ts` reads his changes back as state. Without a backend Life still knows every
// task and action from the ledger (memory/actions.jsonl). What one backend lacks is a capability (`can`), never a
// branch on its name.

/** What a backend can do besides an item's title, notes, day and state (done, undone, removed). */
export type Can =
  | "alarms"
  | "links"
  | "moves"
  | "priority"
  | "recurrence"
  | "sections"
  | "sharing"
  | "subtasks"
  | "urgent";

/** One of his lists (never a group). */
export interface List {
  id: string;
  title: string;
}

/** An item as every backend gives it (remctl's `show`; a Google task, normalised). Ids are strings. */
export interface Item {
  allDay?: boolean;
  completed: boolean;
  createdDate?: string;
  deepLink?: string;
  dueDate?: string;
  flagged?: boolean;
  id: string;
  list?: string | null;
  notes?: string;
  priority?: string;
  recurrence?: unknown;
  section?: string;
  title: string;
  urgent?: boolean;
}

/** What a write left: the item's id now (a move can change it), its link (finds it again after a move), a partial's words. */
export interface Written {
  error?: string;
  id: string;
  link?: string;
}

export interface ActionsBackend {
  /** Adds an item (the default list without `list`); its `subtasks` too when it `can`. */
  add: (c: Partial<Change> & { title: string }) => Promise<Written>;
  can: ReadonlySet<Can>;
  /** His deleted items (Recently Deleted; Google's deleted tasks). */
  deleted: () => Promise<Item[]>;
  done: (id: string) => Promise<unknown>;
  /** Writes these fields (a `list` moves it); `before`, the item as `info` read it. */
  edit: (
    id: string,
    f: Partial<Change>,
    before?: Record<string, unknown>
  ) => Promise<Written>;
  /** One item as it is now, for `before`; throws when there is none. */
  info: (id: string) => Promise<Record<string, unknown>>;
  /** A list's top-level items: open ones, or ticked ones too. */
  items: (list: List, completed: boolean) => Promise<Item[]>;
  /** What he calls it. */
  label: string;
  lists: () => Promise<List[]>;
  /** The ledger's targets are `<prefix>:<id>`. */
  prefix: string;
  remove: (id: string) => Promise<unknown>;
  /** Back from the deleted ones into `list`; a backend without it cannot restore. */
  restore?: (id: string, list?: string) => Promise<unknown>;
  /** Each list's sections by its title. */
  sections: () => Promise<Record<string, string[]>>;
  /** Whether a list is shared, read now (fails closed). */
  shared: (list: string) => Promise<boolean>;
  undone: (id: string) => Promise<unknown>;
}

let built: { b: ActionsBackend; of: unknown } | undefined;
/**
 * This install's backend, made once per settings read (once per process: the watcher's is the one that writes the
 * board), so its own memory (Google's board list) holds. The one gate: it throws while the actions output is off.
 */
export function backend(): ActionsBackend {
  const a = settings().actions;
  if (!a) {
    throw new Error(off("actions"));
  }
  if (built?.of !== a) {
    built = {
      b: a.backend === "google" ? google(a.account, BOARD) : reminders,
      of: a,
    };
  }
  return built.b;
}

/** A change's `target` as the contract's id (a string; Reminders' numbers come as numbers too). */
export const idOf = (target: number | string | undefined) =>
  target === undefined ? undefined : String(target);

/** The agent's board: Life's projection of its tasks (apps/server/src/tasks.ts), a list of his. */
export const BOARD = agentName();

/** The Change fields (and kinds) that need a capability. */
const NEEDS: [Can, (c: Change) => unknown][] = [
  [
    "alarms",
    (c) =>
      [c.due, ...(c.subtasks ?? []).map((s) => s.due)].some((d) =>
        d?.includes(":")
      ),
  ],
  ["links", (c) => c.prompt],
  ["moves", (c) => c.kind === "edit" && c.list],
  ["priority", (c) => c.priority],
  ["recurrence", (c) => c.recurrence],
  ["sections", (c) => c.section],
  ["subtasks", (c) => c.subtasks?.length],
  ["urgent", (c) => c.urgent],
];

/** What a change asks that the backend cannot write (`act` refuses it, saying so). */
export const lacks = (
  c: Change,
  b: Pick<ActionsBackend, "can" | "restore">
) => [
  ...NEEDS.filter(([cap, needs]) => !b.can.has(cap) && needs(c)).map(
    ([cap]) => cap
  ),
  ...(c.kind === "restore" && !b.restore ? ["restore"] : []),
];

/** An open item as `open_reminders` promises it: `due` as a change takes it, notes whole (an edit replaces them). */
export const openOf = (r: Item) => ({
  due:
    r.dueDate &&
    (r.allDay
      ? r.dueDate.slice(0, 10)
      : r.dueDate.slice(0, 16).replace("T", " ")),
  id: r.id,
  list: r.list,
  notes: r.notes,
  section: r.section,
  title: r.title,
});

/** The lists read for his items: one or all, never the board (its tasks are read with `tasks`). */
export const readable = (title: string, list?: string) =>
  title !== BOARD && (list === undefined || title === list);

const listsOf = async (b: ActionsBackend, list?: string) =>
  (await b.lists()).filter((l) => readable(l.title, list));

/** Every open top-level item, of one list or all, never the board: the connector's `open_reminders`. */
export async function openItemsNow(list?: string) {
  const b = backend();
  const open = await Promise.all(
    (await listsOf(b, list)).map((l) => b.items(l, false))
  );
  return open.flat();
}

/** Each of those lists' sections by its name, empty ones too (none where the backend has no sections). */
export async function sectionsOf(list?: string) {
  const b = backend();
  const [lists, all] = await Promise.all([listsOf(b, list), b.sections()]);
  return Object.fromEntries(lists.map((l) => [l.title, all[l.title] ?? []]));
}

/** Whether the backend can act right now (read-only: one read of his lists), the problems: none when it is ready or off. */
export async function checks(): Promise<string[]> {
  if (!isOn("actions")) {
    return [];
  }
  const b = backend();
  try {
    await b.lists();
    return [];
  } catch (e) {
    return [`${b.label}: ${(e as Error).message}`];
  }
}

/** What one pass reads: his unshared lists' items (ticked too), the board's, and the deleted ones. */
export interface Snapshot {
  board: Item[];
  deleted: Item[];
  live: Item[];
  /** The backend's target prefix: the lines read back name its items. */
  prefix: string;
  /** His shared lists, never read: an item Life knows there is left alone. */
  shared: string[];
}

/** One read for the minute pass (board.ts, inbound.ts): every list but a shared one, ticked items too, then the deleted ones. */
export async function pull(): Promise<Snapshot> {
  const b = backend();
  const mine = await b.lists();
  const shared = await Promise.all(
    mine.map((l) => l.title !== BOARD && b.shared(l.title))
  );
  const rows = await Promise.all(
    mine.map((l, i) => (shared[i] ? [] : b.items(l, true)))
  );
  // After the lists: an item he removes meanwhile is live or deleted, never neither.
  const deleted = await b.deleted();
  const all = rows.flat();
  return {
    board: all.filter((r) => r.list === BOARD),
    deleted,
    live: all.filter((r) => r.list !== BOARD),
    prefix: b.prefix,
    shared: mine.filter((_, i) => shared[i]).map((l) => l.title),
  };
}

// The writes `act` decided, made through the backend.

export type Done = Pick<Action, "after" | "before" | "error" | "target">;

/** The fields a change writes, for the record. */
const fieldsOf = ({ kind, target, ...fields }: Partial<Change>) => fields;

/** What an edit changes: the new title and list when they differ from the item's, and every other field that is set. */
export function changedFields(
  c: Change,
  before: { list?: unknown; section?: unknown; title?: unknown }
) {
  const fields = fieldsOf(c);
  for (const k of ["title", "list", "section"] as const) {
    if (fields[k] === before[k]) {
      delete fields[k];
    }
  }
  return fields;
}

/** An item as it is now, for `before`. Throws when there is none with this id. */
export function info(target: number | string | undefined) {
  const id = idOf(target);
  if (id === undefined) {
    throw new Error("this needs a target id");
  }
  return backend().info(id);
}

/** The kinds that only change an item's state, each with what it leaves. */
const FINISH = {
  done: () => ({ completed: true }),
  remove: () => ({ deleted: true }),
  // Back in `list`, under its id and link (Reminders, checked 21 Oct).
  restore: (c: Change) => ({ deleted: false, list: c.list }),
  undone: () => ({ completed: false }),
};

/** Makes one change `act` decided, and says what it left (`after`, `before`, a partial's `error`); throws when it failed. */
export async function write(c: Change): Promise<Done> {
  const b = backend();
  const target = (item: string) => `${b.prefix}:${item}`;
  if (c.kind === "add") {
    const w = await b.add(c);
    return {
      after: { ...fieldsOf(c), id: w.id, link: w.link },
      error: w.error,
      target: target(w.id),
    };
  }
  const id = idOf(c.target) ?? "";
  if (c.kind === "edit") {
    const before = await info(c.target);
    const changed = changedFields(c, before);
    const w = await b.edit(id, changed, before);
    return { after: changed, before, error: w.error, target: target(w.id) };
  }
  // A removed item has no info until it is back.
  const before = c.kind === "restore" ? undefined : await info(c.target);
  // A backend without `restore` never gets here: `act` refused it (`lacks`).
  await (c.kind === "restore" ? b.restore?.(id, c.list) : b[c.kind](id));
  return { after: FINISH[c.kind](c), before, target: target(id) };
}

/** What a change sets, for its intent and a failed try: its fields, or the state a tick, a removal or a restore leaves. */
export const intended = (c: Change) =>
  c.kind in FINISH ? FINISH[c.kind as keyof typeof FINISH](c) : fieldsOf(c);
