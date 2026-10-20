import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  add,
  alarmArgs,
  BOARD,
  partial,
  type Reminder,
  remctl,
  reminderArgs,
} from "./actions";
import { deliveredLines, subscribed } from "./events";
import { WAKE } from "./hear";
import { log } from "./log";
import { readJson } from "./memory/ledger";
import { actionFailedReport, sendReport } from "./memory/report";
import { clip, localTime } from "./memory/units";
import {
  closed,
  escalation,
  nudge,
  standing,
  type Task,
  taskLine,
  tasksOf,
} from "./tasks";
import { ROOT } from "./truth";

// Atlas's board, his Reminders list `BOARD`: a projection of the tasks (src/tasks.ts), never through `act`, that writes
// no ledger line but his steers. One item per task, found by the task id on its notes' first line. Each pass Life brings
// its own fields (notes, section, Atlas's steps as subtasks) to what the ledger says, ticks the item when its task
// closes, and while he is needed moves it to "Needs you" with a due of now (bringing back his tick). The title, the due,
// his tick and his own subtasks are his: what differs from how Life left the item (`SNAPSHOT`) is his change, a steer.

const MIN = 60_000;
/** How each watched item looked after Life's last pass (mode 600: his words). */
const SNAPSHOT = join(ROOT, "derived", "board.json");
const NEEDS = "Needs you";
/** Everything up to its wake (`WAKE`) and the spaces and punctuation after it: the title is his words from there. */
const TO_WAKE = new RegExp(String.raw`^.*?${WAKE.source}[\s\p{P}]*`, "isu");

/** An item as Life reads it; `steps` and `subIds`: its subtasks by title; `made`: the ones Life added (snapshot only). */
export interface Item {
  completed: boolean;
  due: string | null;
  id: number;
  made?: string[];
  notes: string;
  section: string;
  steps: Record<string, boolean>;
  subIds: Record<string, number>;
  title: string;
}

/** What a task's item should say: notes (id, his words, state, latest note, his own note until Atlas's next update). */
export function wantOf(t: Task, cause: string | null) {
  const { deadline, end, state, steers, steps, word } = standing(t);
  const his = steers.findLast((l) => l.after.note);
  const { quote } = t.ask.instruction;
  const until = !closed(state) && deadline && `until ${localTime(deadline)}`;
  const line = [state, until, end.on && `on ${end.on}`, cause];
  const { title } = t.ask.after;
  const notes = [
    t.ask.id,
    clip(quote, 1000),
    line.filter(Boolean).join(" · "),
    word,
    his && `You: ${his.after.note}`,
  ];
  const low = t.ask.after.confidence === "low" ? " (to confirm)" : "";
  const section = state === "open" ? "Open" : "Working";
  return {
    completed: closed(state),
    notes: notes.filter(Boolean).join("\n").trim(),
    section: cause ? NEEDS : section,
    steps: Object.fromEntries(steps.map((x) => [x.title, x.done])),
    title: `Atlas${low}: ${clip((title as string | undefined) ?? (quote.replace(TO_WAKE, "") || quote), 80)}`,
  };
}
type Want = ReturnType<typeof wantOf>;

/** The writes that bring item `it` to `w` (`seen`: how Life left it), and how it will look after them. */
export function planOf(w: Want, it: Item, seen: Item | undefined, now: number) {
  const was = seen?.section === NEEDS;
  const alert = w.section === NEEDS && !was;
  const calm = was && w.section !== NEEDS;
  // A due of now (remctl's local time) when he is first needed, cleared when he no longer is; else his own.
  const due = alert
    ? new Date(now).toLocaleString("sv-SE").slice(0, 16)
    : undefined;
  const titles = Object.keys(w.steps);
  // A step Life added and he removed stays removed.
  const made = seen?.made ?? [];
  const adds = titles.filter((x) => !(x in it.steps || made.includes(x)));
  const ticks = titles.filter((x) => w.steps[x] && it.steps[x] === false);
  const { priv, pub } = reminderArgs({
    due: calm ? null : due,
    notes: w.notes === it.notes ? undefined : w.notes,
    section: w.section === it.section ? undefined : w.section,
    subtasks: adds.map((title) => ({ title })),
  });
  const reopen = alert && it.completed;
  const ticked = ticks.map((x): [string, boolean] => [x, true]);
  const fresh = adds.map((x): [string, boolean] => [x, false]);
  const look = {
    ...it,
    completed: w.completed || (it.completed && !reopen),
    due: calm ? null : (due ?? it.due),
    made: [...made, ...adds],
    notes: w.notes,
    section: w.section,
    steps: { ...it.steps, ...Object.fromEntries([...fresh, ...ticked]) },
  };
  return {
    done: [
      ...(w.completed && !it.completed ? [it.id] : []),
      ...ticks.map((x) => it.subIds[x]),
    ],
    flags: [...pub, ...(calm ? ["--alarm=clear"] : alarmArgs(due)), ...priv],
    // When the private write (section, new steps) fails: the rest landed, the new steps did not.
    kept: {
      ...look,
      made,
      steps: { ...it.steps, ...Object.fromEntries(ticked) },
    },
    look,
    reopen,
  };
}

const KEYS = ["completed", "title", "due", "notes", "steps"] as const;

/**
 * His changes between how Life left an item and how it looks now (their new values), and his note's new lines. Steps
 * compare in any order: Reminders lists subtasks in its own.
 */
export function steerOf(seen: Item, look: Item) {
  const changed = KEYS.filter((k) => !Bun.deepEquals(seen[k], look[k]));
  const before = new Set(seen.notes.split("\n"));
  const note = look.notes
    .split("\n")
    .filter((l) => l.trim() && !before.has(l))
    .join(" / ");
  return {
    changes: Object.fromEntries(changed.map((k) => [k, look[k]])),
    note,
  };
}

/** His steers, by task: what differs from how Life left each open task's item (a deleted item is one). */
export function steersOf(
  tasks: Task[],
  shots: Record<string, Item>,
  items: Map<string, Item>
) {
  return tasks.flatMap((t) => {
    const [seen, item] = [shots[t.ask.id], items.get(t.ask.id)];
    if (!seen || closed(standing(t).state)) {
      return [];
    }
    const steer = item
      ? item.id === seen.id && steerOf(seen, item)
      : { changes: { deleted: true }, note: "" };
    return steer && Object.keys(steer.changes).length
      ? [[t.ask.id, steer] as const]
      : [];
  });
}

const taskOf = (r: Reminder) => r.notes?.split("\n")[0] ?? "";

/** The board's items of these tasks, by task id. */
async function readBoard(tasks: Set<string>) {
  const rows = await remctl<Reminder[]>(["show", BOARD, "--completed"]);
  const read = async (r: Reminder): Promise<[string, Item]> => {
    const { subtasks } = await remctl<{
      subtasks: { completed: boolean; id: number; title: string }[];
    }>(["subtasks", `${r.id}`]);
    const by = <T>(f: (x: (typeof subtasks)[number]) => T) =>
      Object.fromEntries(subtasks.map((x) => [x.title, f(x)]));
    const item: Item = {
      completed: r.completed,
      due: r.dueDate?.slice(0, 16).replace("T", " ") ?? null,
      id: r.id,
      notes: (r.notes ?? "").trim(),
      section: r.section ?? "",
      steps: by((x) => x.completed),
      subIds: by((x) => x.id),
      title: r.title,
    };
    return [taskOf(r), item];
  };
  const mine = rows.filter((r) => tasks.has(taskOf(r)));
  return new Map(await Promise.all(mine.map(read)));
}

/**
 * Brings a task's item in line (a closed task with no item gets none; a new one is added with the task id in its
 * notes, so a failed pass finds it again): how it looks after (a failed private write: its steps as read, and the
 * next pass tries again). When a write fails while he is needed and the item doesn't show it yet, he is
 * emailed, once per incident.
 */
async function mirror(
  t: Task,
  item: Item | undefined,
  seen: Item | undefined,
  cause: string | null,
  now: number
) {
  const w = wantOf(t, cause);
  const task = t.ask.id;
  if (!item && w.completed) {
    return;
  }
  try {
    const it = item ?? (await added(w));
    const p = planOf(w, it, seen, now);
    if (p.done.length > 0) {
      await remctl(["done", ...p.done.map(String)]);
    }
    if (p.reopen) {
      await remctl(["undone", `${it.id}`]);
    }
    if (p.done.length > 0 || p.reopen) {
      // What left or came back to his open list, by id: an audit can tell a ticked item from a lost one.
      log("board.write", { done: p.done, item: it.id, reopen: p.reopen, task });
    }
    const r = p.flags.length
      ? await remctl(["edit", `${it.id}`, ...p.flags])
      : {};
    const half = partial(r);
    if (half) {
      log("run.error", { error: half, step: "tasks.board", task });
      return p.kept;
    }
    return p.look;
  } catch (e) {
    const error = (e as Error).message;
    log("run.error", { error, step: "tasks.board", task });
    if (cause && seen?.section !== NEEDS) {
      const key = `${task}/${cause.split(":")[0]}/${standing(t).since}`;
      const a = { ...t.ask, after: { title: cause }, error };
      await sendReport(`atlas/${key}`, actionFailedReport(a));
    }
    return item && { ...item, made: seen?.made };
  }
}

async function added({ notes, title }: Want): Promise<Item> {
  const { after } = await add({ kind: "add", list: BOARD, notes, title });
  const blank = { completed: false, due: null, section: "", steps: {} };
  return { ...blank, id: Number(after.id), notes, subIds: {}, title };
}

let last = 0;
/**
 * The watcher's pass, each loop: the nudges (from the ledger alone, so a Reminders outage stops none), then, at most
 * each minute, the board: his changes become steers (a deleted item comes back), and each item is brought in line.
 * Only open tasks' items are watched (a closed one's until it is ticked); a lost snapshot is a fresh baseline.
 */
export async function tick(now = Date.now()) {
  nudge(now);
  if (now - last < MIN) {
    return;
  }
  last = now;
  const tasks = () => tasksOf(undefined, deliveredLines());
  const shots = readJson<Record<string, Item>>(SNAPSHOT) ?? {};
  const watched = () =>
    tasks().filter((t) => t.ask.id in shots || !closed(standing(t).state));
  const items = await readBoard(new Set(watched().map((t) => t.ask.id)));
  for (const [task, steer] of steersOf(tasks(), shots, items)) {
    taskLine(task, "steer", steer, now);
  }
  const live = subscribed(now);
  const next: Record<string, Item> = {};
  for (const t of watched()) {
    const [item, shot] = [items.get(t.ask.id), shots[t.ask.id]];
    const { state } = standing(t, now);
    const cause = escalation(t, now, live);
    const seen = shot?.id === item?.id ? shot : undefined;
    // biome-ignore lint/performance/noAwaitInLoops: one item at a time
    const look = await mirror(t, item, seen, cause, now);
    if (look && !(look.completed && closed(state))) {
      next[t.ask.id] = look;
    }
  }
  writeFileSync(SNAPSHOT, `${JSON.stringify(next)}\n`, { mode: 0o600 });
}
