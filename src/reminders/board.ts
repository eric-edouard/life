import { log } from "../log";
import { BOARD, partial, type Reminder, remctl, type Snapshot } from "./remctl";
import { add, reminderArgs } from "./write";

// The board, his list `BOARD`: Atlas's tasks projected, one item per task, found by the task id on its notes' first line.
// Each pass Life brings its own fields (notes, section) to what the ledger says and ticks the item when its task
// closes: his receipt that he was heard. Only his tick or removal of one is read back (`marks`, below).

/** What a task's item should say (`wantOf`, src/tasks.ts): `id` is the task's, the first line of `notes`. */
export interface Receipt {
  completed: boolean;
  id: string;
  notes: string;
  section: string;
  title: string;
}

/** The writes that bring item `it` to `w`. */
export function planOf(w: Receipt, it: Reminder) {
  const { priv, pub } = reminderArgs({
    notes: w.notes === (it.notes ?? "").trim() ? undefined : w.notes,
    section: w.section === (it.section ?? "") ? undefined : w.section,
  });
  return {
    done: w.completed && !it.completed ? [it.id] : [],
    flags: [...pub, ...priv],
  };
}

/** The task a board item is for. */
export const taskOf = (r: Reminder) => r.notes?.split("\n")[0] ?? "";

/**
 * Brings a task's item in line (a closed task with no item gets none; a new one is added with the task id in its
 * notes, so a failed pass finds it again, and a failed private write, the section, is tried again next pass).
 */
async function mirror(w: Receipt, item: Reminder | undefined) {
  const task = w.id;
  if (!item && w.completed) {
    return;
  }
  try {
    const it: Reminder = item ?? {
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
      title: w.title,
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
  const items = new Map(board.map((r) => [taskOf(r), r]));
  for (const w of receipts) {
    const item = items.get(w.id);
    if (!(item?.completed && w.completed)) {
      // biome-ignore lint/performance/noAwaitInLoops: one item at a time
      await mirror(w, item);
    }
  }
}

/** What he did to each task's receipt: ticked it, or removed it (in Recently Deleted, none live). `closings` (src/tasks.ts) reads it for open tasks only. */
export function marks(s: Snapshot) {
  const live = new Map(s.board.map((r) => [taskOf(r), r.completed]));
  const removed = s.deleted.filter((d) => !live.has(taskOf(d)));
  return new Map<string, "removed" | "ticked">([
    ...removed.map((d) => [taskOf(d), "removed"] as const),
    ...[...live]
      .filter(([, done]) => done)
      .map(([t]) => [t, "ticked"] as const),
  ]);
}
