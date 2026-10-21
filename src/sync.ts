import { homedir } from "node:os";
import { join } from "node:path";
import type { Change } from "./actions";
import { unfrozen } from "./clock";
import {
  FIELDS,
  type Field,
  type Fields,
  isTry,
  type Linked,
  linked,
  pick,
} from "./items";
import { log } from "./log";
import { digest } from "./memory/ledger";
import { normalize } from "./memory/units";
import { exec } from "./proc";
import type { Action } from "./schema";

// The only code that touches his Apple Reminders, through remctl (its signed host, `--json`): Reminders is an
// interface to Life, never its truth. `act` (src/actions.ts) decides and records each change he asked for and has
// `write` make it; `push` projects Atlas's tasks onto his list `BOARD`. Delete this file and Life still knows every
// task and every action from the ledger (memory/actions.jsonl).

const REMCTL = join(homedir(), "bin", "remctl");
/** Atlas's board: Life's projection of its tasks (src/tasks.ts). */
export const BOARD = "Atlas";
/** How long a list's own sorter takes to place a new reminder (read-after-write lags about 2 s). */
const SORTER_MS = 3000;

export type Done = Pick<Action, "after" | "before" | "error" | "target">;

const parse = <T>(s: string) => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return {} as T;
  }
};

/**
 * One remctl call (`args[0]` is the command), its JSON. A partial add (created, a private step failed) comes back too;
 * anything else that fails throws remctl's own words. Read-after-write lags about 2 s: never verify with a read at once.
 * Killed after a minute (exec's default), so a stuck Reminders host cannot hold the queue.
 */
export async function remctl<T = Record<string, unknown>>(args: string[]) {
  unfrozen("touch his Reminders");
  const [command, ...rest] = args;
  const r = await exec([REMCTL, command ?? "", "--json", ...rest], {
    env: { ...process.env, NO_COLOR: "1", REMCTL_SKIP_ONBOARD: "1" },
  });
  const out = parse<T & { status?: string }>(r.stdout);
  if (r.code === 0 || out.status === "partial") {
    return out;
  }
  throw new Error(`remctl ${command}: ${r.stderr.trim().slice(-300)}`);
}

/** A timed reminder alerts at its time, as one made in Reminders does: EventKit adds no alarm by itself. */
const alarmAt = (due?: string | null) => (due?.includes(":") ? due : undefined);
/** The alarm flag of a due; none when the reminder already has alarms (remctl moves one that was at the old time; his own stay). */
export const alarmArgs = (due?: string | null, hasAlarms = false) =>
  !hasAlarms && alarmAt(due) ? [`--alarm=${due}`] : [];

/**
 * The remctl flags of a change's fields: `pub` goes through EventKit, `priv` (section, urgent, subtasks, the claude.ai
 * link of a `prompt`) through the private helper, so it is empty unless needed. `--name=value` keeps a value that starts
 * with a dash from being read as a flag. The link only pre-fills a Claude chat, it runs nothing.
 */
export function reminderArgs(c: Partial<Change>) {
  const priv = [
    ...(c.section ? [`--section=${c.section}`] : []),
    ...(c.urgent ? ["--urgent"] : []),
    ...(c.prompt
      ? [`--url=https://claude.ai/new?q=${encodeURIComponent(c.prompt)}`]
      : []),
    ...(c.subtasks ?? []).map(
      (s) => `--subtask=${JSON.stringify({ ...s, alarm: alarmAt(s.due) })}`
    ),
  ];
  return {
    priv: priv.length > 0 ? ["--private", ...priv] : [],
    pub: [
      ...(c.notes === undefined ? [] : [`--notes=${c.notes ?? ""}`]),
      ...(c.due === undefined ? [] : [`--due=${c.due ?? "clear"}`]),
      ...(c.priority ? [`--priority=${c.priority}`] : []),
      ...(c.recurrence ? [`--recurrence=${c.recurrence}`] : []),
    ],
  };
}

/** The fields a change writes, for the record. */
const fieldsOf = ({ kind, target, ...fields }: Partial<Change>) => fields;

/** What an edit changes: the new title and list when they differ from the reminder's, and every other field that is set. */
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

const KEEP =
  "id title list section dueDate alarms notes priority urgent completed".split(
    " "
  );

/** A reminder as it is now, for `before`. Throws when there is none with this id. */
export async function info(target: number | undefined) {
  if (target === undefined) {
    throw new Error("this needs a target reminder id");
  }
  const r = await remctl(["info", "--", String(target)]);
  return Object.fromEntries(KEEP.flatMap((k) => (k in r ? [[k, r[k]]] : [])));
}

const partial = (r: Record<string, unknown>) =>
  r.status === "partial"
    ? `partial: ${r.message ?? r.error ?? "a private step failed"}`
    : undefined;

/** A new reminder. */
async function add(c: Change): Promise<Done> {
  const { priv, pub } = reminderArgs(c);
  const r = await remctl([
    "add",
    ...(c.list ? [`--list=${c.list}`] : []),
    ...pub,
    ...alarmArgs(c.due),
    ...priv,
    "--",
    c.title,
  ]);
  if (typeof r.numericId !== "number") {
    throw new Error("remctl add: no reminder id in its answer");
  }
  let error = partial(r);
  if (c.section) {
    // A list that auto-categorizes (remctl cannot turn that off) re-sorts a new reminder a moment after it exists,
    // over the section asked for: put it back once the sorter is done.
    await Bun.sleep(SORTER_MS);
    try {
      await remctl([
        "edit",
        `${r.numericId}`,
        "--private",
        `--section=${c.section}`,
      ]);
    } catch (e) {
      error ??= `partial: section: ${(e as Error).message}`;
    }
  }
  return {
    // `link`, the deepLink's UUID, finds it again after a move gives it a new id.
    after: { ...fieldsOf(c), id: r.numericId, link: r.id },
    error,
    target: `reminder:${r.numericId}`,
  };
}

async function edit(c: Change): Promise<Done> {
  const before = await info(c.target);
  const changed = changedFields(c, before);
  let id = c.target;
  // A move can clone and delete, which gives the reminder a new id.
  if (changed.list) {
    const moved = await remctl(["edit", `${id}`, `--list=${changed.list}`]);
    id = Number(moved.id ?? id);
  }
  const { priv, pub } = reminderArgs(changed);
  const flags = [
    ...(changed.title ? [`--title=${changed.title}`] : []),
    ...pub,
    ...alarmArgs(changed.due, Boolean(before.alarms)),
    ...priv,
  ];
  // Once a move gave it a new id, a failure is a partial: the record must keep the new id, or the moved reminder reads as his.
  const r =
    flags.length > 0
      ? await remctl(["edit", `${id}`, ...flags]).catch((e: Error) => {
          if (id === c.target) {
            throw e;
          }
          return { message: e.message, status: "partial" };
        })
      : {};
  return {
    after: changed,
    before,
    error: partial(r),
    target: `reminder:${id}`,
  };
}

/** The kinds that only change a reminder's state, each with its remctl call and what it leaves: `finish`'s table. */
const FINISH = {
  done: {
    after: () => ({ completed: true }),
    args: (id: string) => ["done", id],
  },
  remove: {
    after: () => ({ deleted: true }),
    args: (id: string) => ["delete", id, "--force"],
  },
  restore: {
    // Back in `list`, under its id and deepLink (checked 21 Oct).
    after: (c: Change) => ({ deleted: false, list: c.list }),
    args: (id: string, list?: string) => [
      "restore",
      "--private",
      `--list=${list}`,
      "--",
      id,
    ],
  },
  undone: {
    after: () => ({ completed: false }),
    args: (id: string) => ["undone", id],
  },
};

/** Ticks a reminder off or open, removes it (to Recently Deleted) or restores it from there into `list`. */
async function finish(
  c: Change & { kind: keyof typeof FINISH }
): Promise<Done> {
  // A removed reminder has no info until it is back.
  const before = c.kind === "restore" ? undefined : await info(c.target);
  const { after, args } = FINISH[c.kind];
  const left = after(c);
  await remctl(args(`${c.target}`, c.list));
  return { after: left, before, target: `reminder:${c.target}` };
}

/** Makes one change `act` decided, and says what it left (`after`, `before`, a partial's `error`); throws when it failed. */
export function write(c: Change): Promise<Done> {
  if (c.kind === "add") {
    return add(c);
  }
  return c.kind === "edit" ? edit(c) : finish({ ...c, kind: c.kind });
}

/** What a change sets, for its intent and a failed try: its fields, or the state a tick, a removal or a restore leaves. */
export const intended = (c: Change) =>
  c.kind in FINISH
    ? FINISH[c.kind as keyof typeof FINISH].after(c)
    : fieldsOf(c);

/** Whether a list is plainly nobody else's: the grant never adds to a shared one (that would be a send). Fails closed. */
export const unshared = (list: { sharees?: unknown[]; shared?: boolean }) =>
  list.shared === false && list.sharees?.length === 0;

/** Whether his list `name` is shared, read now (`unshared`, so a list remctl says nothing about counts as shared). */
export const isShared = async (name: string) =>
  !unshared(
    await remctl<{ sharees?: unknown[]; shared?: boolean }>([
      "list-info",
      "--",
      name,
    ])
  );

/** A reminder as remctl's `show` gives it (`--completed`: ticked ones too). */
export interface Reminder {
  allDay?: boolean;
  completed: boolean;
  createdDate?: string;
  deepLink?: string;
  dueDate?: string;
  flagged?: boolean;
  id: number;
  isSubtask?: boolean;
  list?: string | null;
  notes?: string;
  priority?: string;
  recurrence?: unknown;
  section?: string;
  title: string;
  urgent?: boolean;
}

/** An open reminder as `open_reminders` promises it: `due` as a change takes it, notes whole (an edit replaces them). */
export const openOf = (r: Reminder) => ({
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

/** The lists read for his reminders: one or all, never the board (its tasks are read with `tasks`). */
export const readable = (title: string, list?: string) =>
  title !== BOARD && (list === undefined || title === list);

/** His lists read for both reads below: `readable` ones, not groups. */
async function listsOf(list?: string) {
  const lists = await remctl<{ id: number; isGroup: boolean; title: string }[]>(
    ["lists"]
  );
  return lists.filter((l) => !l.isGroup && readable(l.title, list));
}

/** Every open top-level reminder, of one list or all, never the board: the connector's `open_reminders`. */
export async function openReminders(list?: string) {
  const open = await Promise.all(
    (await listsOf(list)).map((l) =>
      remctl<Reminder[]>(["show", "--list-id", `${l.id}`])
    )
  );
  return open.flat();
}

/** Each of those lists' sections by its name, empty ones too, from one call: `open_reminders`'s. */
export async function sectionsOf(list?: string) {
  const [lists, all] = await Promise.all([
    listsOf(list),
    remctl<Record<string, string[]>>(["sections"]),
  ]);
  return Object.fromEntries(lists.map((l) => [l.title, all[l.title] ?? []]));
}

/**
 * Whether remctl can act right now (read-only: nothing is written). The problems, none when it is ready. One read
 * through the signed host, not `remctl doctor` (its Tailscale probe times out while Reminders are fine); a broken
 * private helper (sections, subtasks) shows as a partial on an act (in the nightly's Actions); on the board only in
 * the log.
 */
export async function checks() {
  try {
    await remctl(["lists"]);
    return [];
  } catch (e) {
    return [`Reminders: ${(e as Error).message}`];
  }
}

// The board: one item per task, found by the task id on its notes' first line. Each pass Life brings its own fields
// (notes, section) to what the ledger says and ticks the item when its task closes: his receipt that he was heard. It
// reads back only his tick or removal of a receipt (`marks`), which closes its task. What needs him (`escalation`, src/tasks.ts) is emailed by `chase`, never shown here.

/** A board item as Life reads it. */
export type Item = Required<
  Pick<Reminder, "completed" | "id" | "notes" | "section">
>;

/** What a task's item should say (`wantOf`, src/tasks.ts): `id` is the task's, the first line of `notes`. */
export interface Receipt {
  completed: boolean;
  id: string;
  notes: string;
  section: string;
  title: string;
}

/** The writes that bring item `it` to `w`. */
export function planOf(w: Receipt, it: Item) {
  const { priv, pub } = reminderArgs({
    notes: w.notes === it.notes ? undefined : w.notes,
    section: w.section === it.section ? undefined : w.section,
  });
  return {
    done: w.completed && !it.completed ? [it.id] : [],
    flags: [...pub, ...priv],
  };
}

const taskOf = (r: Reminder) => r.notes?.split("\n")[0] ?? "";

/** The board's items, by task id. */
function itemsOf(rows: Reminder[]) {
  const read = (r: Reminder): [string, Item] => [
    taskOf(r),
    {
      completed: r.completed,
      id: r.id,
      notes: (r.notes ?? "").trim(),
      section: r.section ?? "",
    },
  ];
  return new Map(rows.map(read));
}

/**
 * Brings a task's item in line (a closed task with no item gets none; a new one is added with the task id in its
 * notes, so a failed pass finds it again, and a failed private write, the section, is tried again next pass).
 */
async function mirror(w: Receipt, item: Item | undefined) {
  const task = w.id;
  if (!item && w.completed) {
    return;
  }
  try {
    const it = item ?? {
      completed: false,
      id: Number(
        (
          await add({
            kind: "add",
            list: BOARD,
            notes: w.notes,
            title: w.title,
          })
        ).after.id
      ),
      notes: w.notes,
      section: "",
    };
    const p = planOf(w, it);
    if (p.done.length > 0) {
      await remctl(["done", ...p.done.map(String)]);
      // What left his open list, by id: an audit can tell a ticked item from a lost one.
      log("board.write", { done: p.done, item: it.id, task });
    }
    const r = p.flags.length
      ? await remctl(["edit", `${it.id}`, ...p.flags])
      : {};
    const half = partial(r);
    if (half) {
      log("run.error", { error: half, step: "tasks.board", task });
    }
  } catch (e) {
    log("run.error", {
      error: (e as Error).message,
      step: "tasks.board",
      task,
    });
  }
}

/**
 * The board's pass, over the board as `pull` read it: each receipt's item is brought in line (one missing comes back
 * while its task is open; a ticked one of a closed task is left alone: he may have unticked it).
 */
export async function push(receipts: Receipt[], board: Reminder[]) {
  const items = itemsOf(board);
  for (const w of receipts) {
    const item = items.get(w.id);
    if (!(item?.completed && w.completed)) {
      // biome-ignore lint/performance/noAwaitInLoops: one item at a time
      await mirror(w, item);
    }
  }
}

// Inbound: his changes in Reminders come back as state, never as authority (his decision 15, 21 Oct). Each pass compares
// every reminder Life links (an add, or an `import`: the first pass's baseline and any field Life learns) with what the
// ledger says Life left there. A difference is his only if Life did not write or try to write that value since the
// field last settled: `act` records its intent before each write, and a write whose answer was lost still counts as
// Life's (#69, where Life's own writes were read back as his voice). It may close, reopen, reschedule, re-rank, rename,
// drop or add an item; it never asks, sends or grants. Section, order, completionDate and a repeating reminder's due
// are Apple's own, never compared; a shared list is never read (a change there may be someone else's).

/** A live reminder's fields, as a change writes them. */
const fieldsNow = (r: Reminder) =>
  pick({
    completed: r.completed,
    deleted: false,
    due: openOf(r).due,
    flagged: r.flagged,
    list: r.list,
    lost: false,
    notes: r.notes,
    priority: r.priority,
    title: r.title,
    urgent: r.urgent,
  });
const linkOf = (r: Reminder) => r.deepLink?.split("/").at(-1);
/** What one pass reads: his unshared lists' reminders (ticked too), the board's, and Recently Deleted. */
export interface Snapshot {
  board: Reminder[];
  deleted: Reminder[];
  live: Reminder[];
  /** His shared lists, never read: a reminder Life knows there is left alone. */
  shared: string[];
}

/** One line of his, read from Reminders: never his words (no `instruction`), so nothing can take it for a request. */
const his = (
  kind: Action["kind"],
  r: { id: number; title?: unknown },
  at: string,
  after: Fields & { created?: string; link?: string },
  before?: Record<string, unknown>
): Action => ({
  after,
  at,
  before,
  id: `act_${digest("sha1", `reminders:${r.id}|${kind}|${at}`, 12)}`,
  kind,
  madeBy: "reminders",
  result: "ok",
  schemaVersion: 1,
  target: `reminder:${r.id}`,
  why: kind === "import" ? "linked, no change" : "his change in Reminders",
});

const of = (o: Fields, fs: readonly Field[]) =>
  Object.fromEntries(fs.map((f) => [f, o[f]]));

/** A linked reminder's lines: his changes, and an import of the fields Life does not know yet (none is his change). */
function linesFor(
  it: Linked,
  r: Reminder | undefined,
  now: Fields,
  at: string
) {
  const known = (f: Field) => f in it.fields || f === "deleted" || f === "lost";
  const changed = FIELDS.filter(
    (f) =>
      f in now &&
      known(f) &&
      now[f] !== it.fields[f] &&
      !(it.tried.get(f) ?? []).includes(now[f]) &&
      !(f === "due" && r?.recurrence)
  );
  const target = { id: r?.id ?? it.id, title: r?.title ?? it.fields.title };
  const line = (kind: Action["kind"], fs: Field[], rekey = {}) =>
    his(kind, target, at, of(now, fs), { ...of(it.fields, fs), ...rekey });
  const rest = changed.filter((f) => f !== "completed" && f !== "deleted");
  const unknown = FIELDS.filter((f) => f in now && !known(f));
  // A new id first (the edit's `before.id`), so the lines after it find the reminder by it.
  const moved = r && r.id !== it.id ? [line("edit", rest, { id: it.id })] : [];
  return [
    ...(moved.length || rest.length === 0 ? moved : [line("edit", rest)]),
    ...(r && unknown.length > 0
      ? [his("import", r, at, { ...of(now, unknown), link: linkOf(r) })]
      : []),
    ...(changed.includes("completed")
      ? [line(now.completed ? "done" : "undone", ["completed"])]
      : []),
    ...(changed.includes("deleted")
      ? [line(now.deleted ? "remove" : "restore", ["deleted"])]
      : []),
  ];
}

/** The first pass's line for a linked reminder: its fields now, as a baseline (nothing is his change yet). */
const baseline = (
  it: Linked,
  r: Reminder | undefined,
  now: Fields,
  at: string
) =>
  his(
    "import",
    r ?? it,
    at,
    r ? { ...now, link: linkOf(r) } : now,
    r && r.id !== it.id ? { id: it.id } : {}
  );

/** How long after Life's write to a reminder it is left alone: reads lag writes about 2 s, and a pass reads for seconds. */
const LAG_MS = 30_000;

/** A linked reminder's lines this pass: the first pass's baseline, or its changes. */
function linesOf(
  it: Linked,
  r: Reminder | undefined,
  s: Snapshot,
  first: boolean,
  at: string
) {
  const gone = s.deleted.some(
    (d) => d.id === it.id || (it.link !== undefined && linkOf(d) === it.link)
  );
  const now = r ? fieldsNow(r) : pick({ deleted: gone, lost: !gone });
  // Left alone: one Life wrote to moments ago (Reminders' reads lag its writes, and a write may land during the read),
  // one on a shared list (never read), one removed and then purged.
  if (
    Date.parse(at) - Date.parse(it.wrote ?? "") < LAG_MS ||
    s.shared.includes(`${it.fields.list}`) ||
    !(r || gone || !it.fields.deleted)
  ) {
    return [];
  }
  return first ? [baseline(it, r, now, at)] : linesFor(it, r, now, at);
}

/**
 * The lines this pass adds: his changes to linked reminders and his new ones (`add`), and imports, which change
 * nothing: the first pass's baseline (nothing is reported as his then), fields Life learns, Life's own add whose
 * answer was lost.
 */
export function inbound(s: Snapshot, actions: Action[], at: string) {
  const first = !actions.some((a) => a.kind === "import");
  const byId = new Map(s.live.map((r) => [r.id, r]));
  const byLink = new Map(s.live.map((r) => [linkOf(r), r]));
  const lines: Action[] = [];
  for (const it of linked(actions).values()) {
    const r = byId.get(it.id) ?? (it.link ? byLink.get(it.link) : undefined);
    byId.delete(r?.id ?? Number.NaN);
    lines.push(...linesOf(it, r, s, first, at));
  }
  // What is left is open and linked to nothing: his new reminder, or Life's own add whose answer was lost.
  const lost = lostAdds(actions);
  for (const r of byId.values()) {
    if (!r.completed) {
      const kind = first || lost.has(normalize(r.title)) ? "import" : "add";
      const after = {
        ...fieldsNow(r),
        created: r.createdDate,
        link: linkOf(r),
      };
      lines.push(his(kind, r, at, after));
    }
  }
  return lines;
}

/** The titles of Life's adds that never got their answer (an intent or a failure, no ok): such a reminder is Life's. */
function lostAdds(actions: Action[]) {
  const ok = new Set(actions.filter((a) => !isTry(a)).map((a) => a.id));
  const titles = new Set(
    actions
      .filter((a) => a.kind === "add" && !ok.has(a.id))
      .map((a) => normalize(`${a.after.title}`))
  );
  // Once imported, the title is free again: a later reminder of his by that name is his.
  for (const a of actions) {
    if (a.kind === "import") {
      titles.delete(normalize(`${a.after.title}`));
    }
  }
  return titles;
}

/** What he did to each task's receipt: ticked it, or removed it (in Recently Deleted, none live). `closings` (src/tasks.ts) reads it for open tasks only. */
export function marks(s: Snapshot) {
  const live = new Map(s.board.map((r) => [taskOf(r), r]));
  const out = new Map<string, "removed" | "ticked">();
  for (const [task, r] of live) {
    if (r.completed) {
      out.set(task, "ticked");
    }
  }
  for (const d of s.deleted) {
    if (!live.has(taskOf(d))) {
      out.set(taskOf(d), "removed");
    }
  }
  return out;
}

/** One read for the pass: every list but a shared one (never synced), ticked items too, and Recently Deleted. */
export async function pull(): Promise<Snapshot> {
  const lists = await remctl<{ id: number; isGroup: boolean; title: string }[]>(
    ["lists"]
  );
  const mine = lists.filter((l) => !l.isGroup);
  const [shared, bin] = await Promise.all([
    Promise.all(mine.map((l) => l.title !== BOARD && isShared(l.title))),
    remctl<{ items: Reminder[] }>(["deleted"]),
  ]);
  const rows = await Promise.all(
    mine.map((l, i) =>
      shared[i]
        ? []
        : remctl<Reminder[]>(["show", "--list-id", `${l.id}`, "--completed"])
    )
  );
  const all = rows.flat().filter((r) => !r.isSubtask);
  return {
    board: all.filter((r) => r.list === BOARD),
    deleted: bin.items,
    live: all.filter((r) => r.list !== BOARD),
    shared: mine.filter((_, i) => shared[i]).map((l) => l.title),
  };
}
