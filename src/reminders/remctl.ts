import { homedir } from "node:os";
import { join } from "node:path";
import { unfrozen } from "../clock";
import { exec } from "../proc";
import { agentName, settings } from "../settings";

// How Life talks to his Apple Reminders: remctl (its signed host, `--json`), the shape of a reminder, his lists. This
// folder is the only code that touches Reminders, an interface to Life, never its truth: `write.ts` makes the changes
// `act` decides, `board.ts` projects Atlas's tasks, `inbound.ts` reads his changes back as state. Delete the folder and
// Life still knows every task and every action from the ledger (memory/actions.jsonl).

/** remctl, his; or the app's life-eventkit (EventKit, the same commands and answers), set by the app. */
const REMCTL = process.env.LIFE_EVENTKIT ?? join(homedir(), "bin", "remctl");
/** Whether lists have sections: remctl's do, EventKit has none (the board then asks for none). */
export const SECTIONS = !process.env.LIFE_EVENTKIT;
/** Whether the Reminders plugin is on (the `reminders` setting): off, nothing in Life touches Reminders. */
export const remindersOn = () => settings().reminders;

/** Atlas's board: Life's projection of its tasks (src/tasks.ts). */
export const BOARD = agentName();

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
  if (!remindersOn()) {
    throw new Error("Reminders is off (settings: reminders)");
  }
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

export const partial = (r: Record<string, unknown>) =>
  r.status === "partial"
    ? `partial: ${r.message ?? r.error ?? "a private step failed"}`
    : undefined;

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

/** His lists, not groups. */
const hisLists = async () =>
  (
    await remctl<{ id: number; isGroup: boolean; title: string }[]>(["lists"])
  ).filter((l) => !l.isGroup);

/** His lists read for both reads below: `readable` ones. */
const listsOf = async (list?: string) =>
  (await hisLists()).filter((l) => readable(l.title, list));

/** Every open top-level reminder, of one list or all, never the board: the connector's `open_reminders`. */
export async function openReminders(list?: string) {
  const open = await Promise.all(
    (await listsOf(list)).map((l) =>
      remctl<Reminder[]>(["show", `--list-id=${l.id}`])
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

/** What one pass reads: his unshared lists' reminders (ticked too), the board's, and Recently Deleted. */
export interface Snapshot {
  board: Reminder[];
  deleted: Reminder[];
  live: Reminder[];
  /** His shared lists, never read: a reminder Life knows there is left alone. */
  shared: string[];
}

/** One read for the minute pass (board.ts, inbound.ts): every list but a shared one, ticked items too, then Recently Deleted. */
export async function pull(): Promise<Snapshot> {
  const mine = await hisLists();
  const shared = await Promise.all(
    mine.map((l) => l.title !== BOARD && isShared(l.title))
  );
  const rows = await Promise.all(
    mine.map((l, i) =>
      shared[i]
        ? []
        : remctl<Reminder[]>(["show", `--list-id=${l.id}`, "--completed"])
    )
  );
  // After the lists: a reminder he removes meanwhile is live or in the bin, never neither.
  const bin = await remctl<{ items: Reminder[] }>(["deleted"]);
  const all = rows.flat();
  return {
    board: all.filter((r) => r.list === BOARD),
    deleted: bin.items,
    live: all.filter((r) => r.list !== BOARD),
    shared: mine.filter((_, i) => shared[i]).map((l) => l.title),
  };
}
