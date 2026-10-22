import { unfrozen } from "../clock";
import { off } from "../outputs";
import { execOk } from "../proc";
import type { ActionsBackend, Item, List } from "./backend";

// The Google Tasks backend: his tasks through `gog tasks … --json` as `account`. Only `backend.ts` uses it. A task's
// id in the contract is `<list id>/<task id>`: Google names a task within its list. It has notes, a day (no time),
// subtasks (a parent), and none of Reminders' sections, urgent, priority, alarms, moves, restore, recurrence or sharing.

/** A task as gog gives it (the Tasks API's resource). */
export interface Task {
  completed?: string;
  deleted?: boolean;
  due?: string;
  id: string;
  notes?: string;
  parent?: string;
  status?: "completed" | "needsAction";
  title?: string;
  updated?: string;
}

/** A task as the contract's item: its day only (Google keeps no time), all-day. */
export const itemOfTask = (list: List, t: Task): Item => ({
  allDay: true,
  completed: t.status === "completed",
  dueDate: t.due,
  id: `${list.id}/${t.id}`,
  list: list.title,
  notes: t.notes,
  title: t.title ?? "",
});

/** A change's fields as gog's flags (`--name=value`: a value starting with a dash stays a value; empty clears). */
export const taskArgs = (f: {
  due?: string | null;
  notes?: string | null;
  title?: string;
}) => [
  ...(f.title === undefined ? [] : [`--title=${f.title}`]),
  ...(f.notes === undefined ? [] : [`--notes=${f.notes ?? ""}`]),
  ...(f.due === undefined ? [] : [`--due=${f.due ?? ""}`]),
];

/** `<list id>/<task id>` as gog's two arguments. */
const split = (id: string) => {
  const at = id.indexOf("/");
  return [id.slice(0, at), id.slice(at + 1)];
};

export function google(account: string): ActionsBackend {
  const gog = async <T>(args: string[]) => {
    unfrozen("touch his Google Tasks");
    const why = off("actions");
    if (why) {
      throw new Error(why);
    }
    const out = await execOk([
      "gog",
      "tasks",
      ...args,
      `--account=${account}`,
      "--json",
      "--no-input",
    ]);
    return (out.trim() ? JSON.parse(out) : {}) as T;
  };
  /** Every page of a list's tasks, top-level ones only (a subtask is part of its parent, as in Reminders). */
  const tasks = async (l: List, flags: string[]) => {
    const all: Task[] = [];
    let page = "";
    do {
      // biome-ignore lint/performance/noAwaitInLoops: pages follow one another
      const r = await gog<{ nextPageToken?: string; tasks?: Task[] }>([
        "list",
        l.id,
        "--max=100",
        ...flags,
        ...(page ? [`--page=${page}`] : []),
      ]);
      all.push(...(r.tasks ?? []));
      page = r.nextPageToken ?? "";
    } while (page);
    return all.filter((t) => !t.parent);
  };
  const lists = async () =>
    (await gog<{ tasklists?: List[] }>(["lists", "list"])).tasklists?.map(
      ({ id, title }) => ({ id, title })
    ) ?? [];
  /** A list by its title; without one, his first (Google's default). */
  const listNamed = async (title?: string) => {
    const all = await lists();
    const l = title ? all.find((x) => x.title === title) : all[0];
    if (!l) {
      throw new Error(`Google Tasks: no list ${title ?? "at all"}`);
    }
    return l;
  };
  const listOf = async (id: string) =>
    (await lists()).find((l) => l.id === split(id)[0]) ?? {
      id: split(id)[0] ?? "",
      title: "",
    };
  const get = async (id: string) => {
    const r = await gog<{ task?: Task }>(["get", ...split(id)]);
    if (!r.task) {
      throw new Error(`Google Tasks: no task ${id}`);
    }
    return itemOfTask(await listOf(id), r.task);
  };
  return {
    async add(c) {
      const l = await listNamed(c.list);
      const r = await gog<{ task?: Task }>(["add", l.id, ...taskArgs(c)]);
      if (!r.task) {
        throw new Error("gog tasks add: no task in its answer");
      }
      const { id } = r.task;
      let error: string | undefined;
      for (const s of c.subtasks ?? []) {
        // biome-ignore lint/performance/noAwaitInLoops: in order, under their parent
        await gog(["add", l.id, ...taskArgs(s), `--parent=${id}`]).catch(
          (e: Error) => {
            error ??= `partial: subtask: ${e.message}`;
          }
        );
      }
      return { error, id: `${l.id}/${id}` };
    },
    can: new Set(["subtasks"]),
    async checks() {
      try {
        await lists();
        return [];
      } catch (e) {
        return [`Google Tasks: ${(e as Error).message}`];
      }
    },
    async deleted() {
      const all = await lists();
      const rows = await Promise.all(
        all.map(async (l) =>
          (
            await tasks(l, [
              "--show-deleted",
              "--show-hidden",
              "--show-completed",
            ])
          )
            .filter((t) => t.deleted)
            .map((t) => itemOfTask(l, t))
        )
      );
      return rows.flat();
    },
    done: (id) => gog(["done", ...split(id)]),
    async edit(id, f) {
      await gog(["update", ...split(id), ...taskArgs(f)]);
      return { id };
    },
    async info(id) {
      const { completed, dueDate, list, notes, title } = await get(id);
      return { completed, dueDate, id, list, notes, title };
    },
    items: async (l, completed) =>
      (
        await tasks(l, completed ? ["--show-completed", "--show-hidden"] : [])
      ).map((t) => itemOfTask(l, t)),
    label: "Google Tasks",
    lists,
    prefix: "gtask",
    remove: (id) => gog(["delete", ...split(id), "--force"]),
    restore: () => {
      throw new Error("Google Tasks cannot restore a deleted task");
    },
    sections: async () => ({}),
    shared: async () => false,
    undone: (id) => gog(["undo", ...split(id)]),
  };
}
