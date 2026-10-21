import { homedir } from "node:os";
import { join } from "node:path";
import type { Change } from "./actions";
import { unfrozen } from "./clock";
import { log } from "./log";
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

type Done = Pick<Action, "after" | "before" | "error" | "target">;

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
export const fieldsOf = ({ kind, target, ...fields }: Partial<Change>) =>
  fields;

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

export const partial = (r: Record<string, unknown>) =>
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
    after: { ...fieldsOf(c), id: r.numericId },
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
  const r = flags.length > 0 ? await remctl(["edit", `${id}`, ...flags]) : {};
  return {
    after: changed,
    before,
    error: partial(r),
    target: `reminder:${id}`,
  };
}

/** The kinds that only change a reminder's state, each with its remctl call and what it leaves: `finish`'s table. */
const FINISH = {
  done: { after: { completed: true }, args: (id: string) => ["done", id] },
  remove: {
    after: { deleted: true },
    args: (id: string) => ["delete", id, "--force"],
  },
  restore: {
    after: { deleted: false },
    args: (id: string, list?: string) => [
      "restore",
      "--private",
      `--list=${list}`,
      "--",
      id,
    ],
  },
  undone: { after: { completed: false }, args: (id: string) => ["undone", id] },
};

/** Ticks a reminder off or open, removes it (to Recently Deleted) or restores it from there into `list`. */
async function finish(
  c: Change & { kind: keyof typeof FINISH }
): Promise<Done> {
  // A removed reminder has no info until it is back.
  const before = c.kind === "restore" ? undefined : await info(c.target);
  const { after, args } = FINISH[c.kind];
  await remctl(args(`${c.target}`, c.list));
  return { after, before, target: `reminder:${c.target}` };
}

/** Makes one change `act` decided, and says what it left (`after`, `before`, a partial's `error`); throws when it failed. */
export function write(c: Change): Promise<Done> {
  if (c.kind === "add") {
    return add(c);
  }
  return c.kind === "edit" ? edit(c) : finish({ ...c, kind: c.kind });
}

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
  dueDate?: string;
  id: number;
  list?: string;
  notes?: string;
  section?: string;
  title: string;
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

/** Every open top-level reminder, of one list or all, never the board: what an add's title is checked against, and the connector's `open_reminders`. */
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
// reads nothing back as his. What needs him (`escalation`, src/tasks.ts) is emailed by `chase`, never shown here.

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

/** The board's items of these tasks, by task id. */
async function readBoard(tasks: Set<string>) {
  const rows = await remctl<Reminder[]>(["show", BOARD, "--completed"]);
  const read = (r: Reminder): [string, Item] => [
    taskOf(r),
    {
      completed: r.completed,
      id: r.id,
      notes: (r.notes ?? "").trim(),
      section: r.section ?? "",
    },
  ];
  return new Map(rows.filter((r) => tasks.has(taskOf(r))).map(read));
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

/** The board's pass: each receipt's item is brought in line (a deleted one comes back; a ticked one of a closed task is left alone: he may have unticked it). */
export async function push(receipts: Receipt[]) {
  const items = await readBoard(new Set(receipts.map((w) => w.id)));
  for (const w of receipts) {
    const item = items.get(w.id);
    if (!(item?.completed && w.completed)) {
      // biome-ignore lint/performance/noAwaitInLoops: one item at a time
      await mirror(w, item);
    }
  }
}
