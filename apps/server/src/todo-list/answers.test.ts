import { expect, test } from "bun:test";
import { BOARD, openOf } from "../todo-list/backend";
import {
  type GoogleTask,
  google,
  taskArgs,
  itemOfTask as taskItem,
} from "../todo-list/google";
import { itemOf, type Raw, reminders, unshared } from "../todo-list/remctl";
import gog from "./gog.json";
import answers from "./remctl.json";

// Each backend's answers as Life reads them: remctl's (remctl.json, `REMCTL_RELEASE`'s: what moving the pin checks),
// and gog's (gog.json).

test("a reminder's due is local wall time, as `read_open_todo_items` shows it, and its id a string", () => {
  const r = itemOf((answers.show as Raw[])[0] as Raw);
  expect(openOf(r).due).toBe("2026-10-22 09:00");
  expect(r.id).toBe("412");
});

const UUID = /^[0-9A-F-]{36}$/;

test("an add answers its number and its deep link's id, a list says whether it is shared", () => {
  expect(typeof answers.add.numericId).toBe("number");
  expect(answers.add.id).toMatch(UUID);
  expect(unshared(answers["list-info"])).toBe(true);
});

test("a Google task reads as an item: its list's id in its id, its day only, ticked by its status", () => {
  const [list] = gog.lists.tasklists;
  const [open, , gone] = gog.list.tasks as GoogleTask[];
  const item = taskItem(
    list as { id: string; title: string },
    open as GoogleTask
  );
  expect(item.id).toBe("bGlzdEhvbWU/dGFza0EwMQ");
  expect(openOf(item)).toMatchObject({
    due: "2026-10-22",
    list: "Errands",
    notes: "the blue one",
    title: "Buy a lamp",
  });
  expect(
    taskItem(list as { id: string; title: string }, gone as GoogleTask)
  ).toMatchObject({
    completed: true,
  });
});

test("on Google the board's list is made on first need, once; another missing list is an error", async () => {
  const calls: string[][] = [];
  const b = google("owner@example.test", BOARD, (args) => {
    calls.push(args);
    if (args[0] === "lists") {
      return Promise.resolve(
        args[1] === "create"
          ? { tasklist: { ...gog.create.tasklist, title: args[2] } }
          : gog.lists
      );
    }
    return Promise.resolve(args[0] === "add" ? gog.add : {});
  });
  const first = await b.add({ list: BOARD, notes: "entry_1", title: "A task" });
  await b.add({ list: BOARD, notes: "entry_2", title: "Another" });
  expect(first.id).toBe(`${gog.create.tasklist.id}/${gog.add.task.id}`);
  expect(calls.filter((c) => c[1] === "create")).toEqual([
    ["lists", "create", BOARD],
  ]);
  await expect(b.add({ list: "Nowhere", title: "x" })).rejects.toThrow(
    "no list Nowhere"
  );
});

test("a change's fields go to gog as one value each, a dash kept as a value, null clearing", () => {
  expect(taskArgs({ due: "2026-10-22", notes: "-- n", title: "T" })).toEqual([
    "--title=T",
    "--notes=-- n",
    "--due=2026-10-22",
  ]);
  expect(taskArgs({ due: null, notes: null })).toEqual(["--notes=", "--due="]);
  expect(taskArgs({})).toEqual([]);
});

test("a Reminders id is digits: a string target never reaches remctl's argv as a flag", () => {
  for (const id of ["--all", "12 --force", "list/task"]) {
    expect(() => reminders.done(id)).toThrow("is not a Reminders id");
    expect(() => reminders.remove(id)).toThrow("is not a Reminders id");
  }
});
