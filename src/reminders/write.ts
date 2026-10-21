import type { Change } from "../actions";
import type { Action } from "../schema";
import { partial, remctl } from "./remctl";

// Life's writes to his Reminders: each change `act` (src/actions.ts) decided and recorded, made through remctl.

/** How long a list's own sorter takes to place a new reminder (read-after-write lags about 2 s). */
const SORTER_MS = 3000;

export type Done = Pick<Action, "after" | "before" | "error" | "target">;

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

/** A new reminder. */
export async function add(c: Change): Promise<Done> {
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
