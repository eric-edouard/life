import { expect, test } from "bun:test";
import type { LedgerEntry } from "../records/ledger-entry";
import {
  openTodoItemKeysOf,
  pickCompared,
  todoItemsOf,
} from "./todo-items-from-ledger";

const action = (over: Partial<LedgerEntry>): LedgerEntry => ({
  after: {},
  at: "2026-10-15T10:00:00.000Z",
  id: "entry_0123456789ab",
  kind: "add",
  result: "ok",
  schemaVersion: 1,
  target: "reminder:12",
  via: "session",
  why: "he asked",
  ...over,
});

// life#242 step 1: Life's record keeps what only Life writes (section, recurrence, subtasks), never compared.
test("the fold keeps section, recurrence and every subtask written; 'clear' stops a recurrence; inbound compares none", () => {
  const add = action({
    after: {
      list: "Travel",
      recurrence: "weekly mon",
      section: "Visa",
      subtasks: [{ title: "Photos" }],
      title: "Renew visa",
    },
  });
  const more = action({
    after: { subtasks: [{ title: "Form" }] },
    at: "2026-10-15T11:00:00.000Z",
    id: "entry_0123456789ac",
    kind: "edit",
  });
  const stop = action({
    after: { recurrence: "clear" },
    at: "2026-10-15T12:00:00.000Z",
    id: "entry_0123456789ad",
    kind: "edit",
  });
  const kept = todoItemsOf([add, more]).get("reminder:12")?.fields;
  expect(kept).toMatchObject({
    recurrence: "weekly mon",
    section: "Visa",
    subtasks: [{ title: "Photos" }, { title: "Form" }],
  });
  expect(
    todoItemsOf([add, more, stop]).get("reminder:12")?.fields.recurrence
  ).toBeNull();
  expect(
    pickCompared({
      recurrence: { frequency: "daily" },
      section: "Visa",
      subtasks: [],
      title: "x",
    })
  ).toEqual({ title: "x" });
});

// What got done shows the day an item was ticked: the last time it turned closed, never its making.
test("an item's closedAt is the last time it turned closed; reopening clears it", () => {
  const add = action({ after: { title: "Post the watch" } });
  const edit = (n: number, at: string, after: Record<string, unknown>) =>
    action({ after, at, id: `entry_0123456789b${n}`, kind: "edit" });
  const ticked = edit(1, "2026-10-16T09:00:00.000Z", { completed: true });
  const renamed = edit(2, "2026-10-16T10:00:00.000Z", { title: "Post it" });
  const reopened = edit(3, "2026-10-17T09:00:00.000Z", { completed: false });
  const again = edit(4, "2026-10-18T09:00:00.000Z", { completed: true });
  const item = (list: LedgerEntry[]) => todoItemsOf(list).get("reminder:12");
  expect(item([add])?.closedAt).toBeUndefined();
  expect(item([add, ticked, renamed])?.closedAt).toBe(ticked.at);
  expect(item([add, ticked, reopened])?.closedAt).toBeUndefined();
  expect(item([add, ticked, reopened, again])?.closedAt).toBe(again.at);
});

test("a deletion names the keys of this install's list app only: another app's item stays as it is", () => {
  const add = (target: string, at: string, id: string) =>
    action({ after: { title: String(target) }, at, id, target });
  const actions = [
    add("reminder:12", "2026-10-15T10:00:00.000Z", "entry_0123456789ab"),
    add(
      "gtask:list-1/task-9",
      "2026-10-15T10:01:00.000Z",
      "entry_0123456789ac"
    ),
  ];
  // The test's settings use Apple Reminders (`backendPrefix`): the Google task's line is no item of this list.
  expect(openTodoItemKeysOf(actions)).toEqual(["entry_0123456789ab"]);
});
