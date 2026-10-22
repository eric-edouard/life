import { log } from "../log";
import {
  type ActionsBackend,
  BOARD,
  backend,
  type Item,
  type Snapshot,
} from "./backend";

// The board, his list `BOARD`: the agent's tasks projected, one item per task, found by the task id on its notes' first line.
// Each pass Life brings its own fields (notes, and the section where the backend has sections; the notes say the
// task's state either way) to what the ledger says and ticks the item when its task
// closes: his receipt that he was heard. Only his tick or removal of one is read back (`marks`, below).

/** What a task's item should say (`wantOf`, apps/server/src/tasks.ts): `id` is the task's, the first line of `notes`. */
export interface Receipt {
  completed: boolean;
  id: string;
  notes: string;
  section: string;
  title: string;
}

/** The writes that bring item `it` to `w`: whether to tick it, and the fields to write (a section only where there are sections). */
export function planOf(w: Receipt, it: Item, sections = true) {
  return {
    done: w.completed && !it.completed,
    fields: {
      ...(w.notes === (it.notes ?? "").trim() ? {} : { notes: w.notes }),
      ...(!sections || w.section === (it.section ?? "")
        ? {}
        : { section: w.section }),
    },
  };
}

/** The task a board item is for. */
export const taskOf = (r: Item) => r.notes?.split("\n")[0] ?? "";

/**
 * Brings a task's item in line (a closed task with no item gets none; a new one is added with the task id in its
 * notes, so a failed pass finds it again, and a failed private write, the section, is tried again next pass).
 */
async function mirror(b: ActionsBackend, w: Receipt, item: Item | undefined) {
  const task = w.id;
  if (!item && w.completed) {
    return;
  }
  try {
    const it: Item = item ?? {
      completed: false,
      id: (await b.add({ list: BOARD, notes: w.notes, title: w.title })).id,
      notes: w.notes,
      title: w.title,
    };
    const p = planOf(w, it, b.can.has("sections"));
    if (p.done) {
      await b.done(it.id);
      // What left his open list, by id: an audit can tell a ticked item from a lost one.
      log("board.write", { done: [it.id], item: it.id, task });
    }
    const half =
      Object.keys(p.fields).length > 0
        ? (await b.edit(it.id, p.fields)).error
        : undefined;
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
export async function push(receipts: Receipt[], board: Item[]) {
  const b = backend();
  const items = new Map(board.map((r) => [taskOf(r), r]));
  for (const w of receipts) {
    const item = items.get(w.id);
    if (!(item?.completed && w.completed)) {
      // biome-ignore lint/performance/noAwaitInLoops: one item at a time
      await mirror(b, w, item);
    }
  }
}

/** What he did to each task's receipt: ticked it, or removed it (in Recently Deleted, none live). `closings` (apps/server/src/tasks.ts) reads it for open tasks only. */
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
