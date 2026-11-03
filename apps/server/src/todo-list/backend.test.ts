import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIFE_CODE_DIR } from "../core/paths";
import { repoFiles } from "../core/proc";
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
    "moves",
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

const IMPORT = /import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g;
const BACKEND = /\/backend$/;
const IMPLEMENTATIONS = /\/(remctl|google)$/;

/** The server's files that import any of `names` from a path matching `from`. */
const importers = (names: string[], from: RegExp) =>
  repoFiles(LIFE_CODE_DIR, ["apps/server/src"], [".ts"])
    .filter((f) => !f.endsWith(".test.ts"))
    .filter((f) =>
      [...readFileSync(join(LIFE_CODE_DIR, f), "utf8").matchAll(IMPORT)].some(
        ([, what = "", path = ""]) =>
          from.test(path) &&
          what.split(",").some((w) => names.includes(w.trim()))
      )
    );

// 2 Nov 2026: the agent boards wrote his Reminders beside `act`, so the minute pass read each of their items back as
// his new to-do and the board added it again: 147 copies in 85 minutes. One writer: only `act` reaches a backend.
test("only act writes his to-do list: the backend and its write are imported by act.ts alone, the implementations by backend.ts", () => {
  expect(importers(["backend", "write"], BACKEND)).toEqual([
    "apps/server/src/host/act.ts",
  ]);
  expect(importers(["reminders", "google"], IMPLEMENTATIONS)).toEqual([
    "apps/server/src/todo-list/backend.ts",
  ]);
});
