import {
  add,
  BOARD,
  partial,
  type Reminder,
  remctl,
  reminderArgs,
} from "./actions";
import { clock } from "./clock";
import { subscribed } from "./events";
import { titleOf } from "./hear";
import { log } from "./log";
import { lapseReport, sendReport, taskReport, unsent } from "./memory/report";
import { clip, localTime } from "./memory/units";
import { alerts, closed, settled, standing, type Task, tasksOf } from "./tasks";

// Atlas's board, his Reminders list `BOARD`: a one-way projection of the tasks (src/tasks.ts), never through `act`, that
// writes no ledger line and reads nothing back as his. One item per task, found by the task id on its notes' first
// line. Each pass Life brings its own fields (notes, section) to what the ledger says and ticks the item when its task
// closes: his receipt that he was heard. What needs him (`escalation`, src/tasks.ts) is emailed by `chase`, never shown here.

const MIN = 60_000;
/** A task's name, as the board, the email and `search` show it. */
export const nameOf = (t: Task) =>
  titleOf({
    quote: t.ask.instruction.quote,
    title: t.ask.after.title as string | undefined,
  });

/** An item as Life reads it. */
export interface Item {
  completed: boolean;
  id: number;
  notes: string;
  section: string;
}

/** What a task's item should say: notes (id, his words, state, latest note). */
export function wantOf(t: Task) {
  const { deadline, end, state, word } = standing(t);
  const { quote } = t.ask.instruction;
  const until = !closed(state) && deadline && `until ${localTime(deadline)}`;
  const line = [state, until, end.on && `on ${end.on}`];
  const notes = [
    t.ask.id,
    clip(quote, 1000),
    line.filter(Boolean).join(" · "),
    word,
  ];
  const low = t.ask.after.confidence === "low" ? " (to confirm)" : "";
  return {
    completed: closed(state),
    notes: notes.filter(Boolean).join("\n").trim(),
    section: state === "open" ? "Open" : "Working",
    title: `Atlas${low}: ${nameOf(t)}`,
  };
}
type Want = ReturnType<typeof wantOf>;

/** The writes that bring item `it` to `w`. */
export function planOf(w: Want, it: Item) {
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
async function mirror(t: Task, item: Item | undefined) {
  const w = wantOf(t);
  const task = t.ask.id;
  if (!item && w.completed) {
    return;
  }
  try {
    const it = item ?? (await added(w));
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

async function added({ notes, title }: Want): Promise<Item> {
  const { after } = await add({ kind: "add", list: BOARD, notes, title });
  return { completed: false, id: Number(after.id), notes, section: "" };
}

/**
 * Emails him what newly needs him, one email a pass, each key once (`sendReport`): a lapsed subscription alone, else
 * every task with a new cause (one that goes silent again after an update is new).
 */
export async function chase(
  tasks: Task[],
  now: number,
  live = subscribed(now)
) {
  const due = alerts(tasks, now, live);
  const fresh = new Set(await unsent(due.map((a) => a.key)));
  const news = due.filter((a) => fresh.has(a.key));
  const [first] = news;
  if (!first) {
    return;
  }
  await sendReport(
    news.map((a) => a.key),
    "open" in first
      ? lapseReport(first.open, now)
      : taskReport(
          news.flatMap((a) =>
            "t" in a
              ? [{ ask: a.t.ask, cause: a.cause, title: nameOf(a.t) }]
              : []
          ),
          now
        )
  );
}

let last = 0;
/**
 * The watcher's pass, at most each minute: the chase (from the ledger alone, so a Reminders outage stops no email),
 * then the board: each item is brought in line (a deleted one of an open task comes back).
 */
export async function tick(now = clock().getTime()) {
  if (now - last < MIN) {
    return;
  }
  last = now;
  const tasks = tasksOf();
  await chase(tasks, now);
  const items = await readBoard(new Set(tasks.map((t) => t.ask.id)));
  for (const t of tasks) {
    const item = items.get(t.ask.id);
    const s = standing(t);
    // A task closed over a day ago is left alone: he may have unticked its item.
    if (!(settled(s, now) || (item?.completed && closed(s.state)))) {
      // biome-ignore lint/performance/noAwaitInLoops: one item at a time
      await mirror(t, item);
    }
  }
}
