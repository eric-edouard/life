import { expect, test } from "bun:test";
import { changedFields, lacks, openOf } from "./backend";
import { Change } from "./contract";
import { reminders } from "./remctl";

test("what a backend cannot write is refused by capability: Google Tasks takes a day, notes and subtasks, nothing of Reminders' own", () => {
  const google = { can: new Set(["subtasks"] as const) };
  const add = { kind: "add", title: "Call the plumber" } as const;
  expect(lacks({ ...add, due: "2026-10-22", notes: "n" }, google)).toEqual([]);
  expect(lacks({ ...add, subtasks: [{ title: "Ask" }] }, google)).toEqual([]);
  expect(
    lacks(
      { ...add, due: "2026-10-22 09:00", section: "Later", urgent: true },
      google
    )
  ).toEqual(["alarms", "sections", "urgent"]);
  expect(lacks({ ...add, kind: "edit", list: "Work" }, google)).toEqual([
    "listMoves",
  ]);
  expect(lacks({ ...add, kind: "restore" }, google)).toEqual(["restore"]);
  expect(
    lacks({ ...add, priority: "high", prompt: "p", section: "S" }, reminders)
  ).toEqual([]);
});

test("an open reminder keeps the six fields `read_open_todo_items` promises, its due as a change takes it", () => {
  const r = {
    allDay: false,
    completed: false,
    deepLink: "x-apple-reminderkit://REMCDReminder/1",
    dueDate: "2026-10-22T09:30:00",
    flagged: false,
    id: "1",
    list: "Home",
    notes: "a\nb",
    section: "Soon",
    title: "Call the bank",
  };
  expect(openOf(r)).toEqual({
    due: "2026-10-22 09:30",
    id: "1",
    list: "Home",
    notes: "a\nb",
    section: "Soon",
    title: "Call the bank",
  });
  expect(
    openOf({ ...r, allDay: true, dueDate: "2026-10-22T00:00:00" }).due
  ).toBe("2026-10-22");
  expect(openOf({ ...r, dueDate: undefined }).due).toBeUndefined();
  // What it reads is what a change takes: its due, and its id as the target (a Reminders number still passes).
  expect(Change.shape.due.safeParse(openOf(r).due).success).toBe(true);
  for (const target of [openOf(r).id, 1, "list/task"]) {
    expect(Change.shape.target.safeParse(target).success).toBe(true);
  }
});

test("an edit changes the title and list only when they differ, and every other field that is set", () => {
  const c = {
    due: "2026-10-16",
    kind: "edit",
    list: "Travel",
    target: 7,
    title: "Same",
  } as const;
  expect(changedFields(c, { list: "Travel", title: "Same" })).toEqual({
    due: "2026-10-16",
  });
  expect(changedFields(c, { list: "Inbox", title: "Old" })).toEqual({
    due: "2026-10-16",
    list: "Travel",
    title: "Same",
  });
});
