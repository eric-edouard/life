import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { setSettings, settings } from "../core/settings";
import { LEDGER } from "../memory/memory-files";
import type { LedgerEntry } from "../records/ledger-entry";
import { unshared } from "../todo-list/remctl";
import {
  AutoAdded,
  autoAddedFrom,
  autoAddRefusal,
  changeAskedTodoItem,
  duplicateOf,
  entryId,
  requested,
} from "./change-todo-item";

test("an add repeats an open to-do item with the same title, whatever the case and accents; nothing else is a duplicate", () => {
  const add = { kind: "add", title: "Dîner avec Gaston" } as const;
  const open = [
    { completed: false, target: "reminder:9", title: " dîner AVEC gaston" },
  ];
  expect(duplicateOf(add, open)).toBe("reminder:9");
  expect(
    duplicateOf({ ...add, title: "Dîner avec Jérôme" }, open)
  ).toBeUndefined();
  expect(duplicateOf({ ...add, kind: "edit" }, open)).toBeUndefined();
});

test("the same words asking for the same thing get the same id, whatever the case and accents", () => {
  const id = entryId("job:1@t", "add", "Appeler le plombier");
  expect(entryId("job:1@t", "add", "  appelér le PLOMBIER ")).toBe(id);
  expect(entryId("job:2@t", "add", "Appeler le plombier")).not.toBe(id);
});

test("two requests the same day for the same edit both change the list: each has a ref of its own", () => {
  const id = (at: string) =>
    entryId(requested("session", "rename it", at).ref, "edit", "Same title");
  expect(id("2026-10-19T09:00:00.000Z")).not.toBe(
    id("2026-10-19T15:00:00.000Z")
  );
});

/** A ledger line of an add (the auto-add permission's when `ref` is an observation) or a remove. */
const line = (
  kind: "add" | "edit" | "remove" | "auto_add",
  target: string,
  ref: string,
  at = "2026-10-21T10:00:00.000Z"
): LedgerEntry => ({
  // As `changeTodoItem` writes them: a removal leaves `deleted`, and each line has its own id.
  after: kind === "remove" ? { deleted: true } : {},
  at,
  id: entryId(ref, kind, target),
  instruction: { at, quote: "q", ref },
  kind,
  result: "ok",
  schemaVersion: 1,
  target,
  via: "connector",
  why: "",
});
const NOW = "2026-10-21T12:00:00.000Z";
/** His yes, said in a Claude session before everything else here. */
const yes = {
  ...line("auto_add", "auto_add", "session:x", "2026-10-01T10:00:00.000Z"),
  after: { on: true },
};
const mine = {
  actions: [yes],
  list: { shared: false, sharees: [] },
  mine: true,
  now: NOW,
  o: {
    importance: 3,
    source: { channel: "lifelog" as const, ref: "job:3@2026-10-21T09:00:00Z" },
    type: "to_do" as const,
  },
  state: "active",
};

test("the auto-add permission adds his own current importance-3 to-do from a turn lifelog credits to him, on a list nobody shares", () => {
  expect(autoAddRefusal(mine)).toBeUndefined();
  expect(
    autoAddRefusal({ ...mine, o: { ...mine.o, type: "promise" } })
  ).toBeUndefined();
});

test("the auto-add permission refuses a chat or mail observation, another speaker's or an unnamed turn, and anything not current, salient, a to-do or promise", () => {
  for (const channel of ["whatsapp", "mail"] as const) {
    expect(
      autoAddRefusal({
        ...mine,
        o: { ...mine.o, source: { channel, ref: "m1" } },
      })
    ).toContain("lifelog credits to his voice");
  }
  // Re-read when it is applied: someone else's turn, or one lifelog no longer names him on.
  expect(autoAddRefusal({ ...mine, mine: false })).toContain("his voice");
  expect(autoAddRefusal({ ...mine, state: "retired" })).toContain(
    "not current"
  );
  expect(
    autoAddRefusal({ ...mine, o: { ...mine.o, importance: 2 } })
  ).toContain("importance");
  expect(autoAddRefusal({ ...mine, o: { ...mine.o, type: "idea" } })).toContain(
    "promises"
  );
});

test("the auto-add permission adds at most 3 in his day; the 4th is refused, yesterday's don't count", () => {
  const three = ["1", "2", "3"].map((n) =>
    line("add", `reminder:${n}`, `obs_00000000000${n}`)
  );
  expect(
    autoAddRefusal({ ...mine, actions: [yes, ...three.slice(0, 2)] })
  ).toBeUndefined();
  expect(autoAddRefusal({ ...mine, actions: [yes, ...three] })).toContain(
    "3 today"
  );
  const yesterday = three.map((a) => ({
    ...a,
    at: "2026-10-20T10:00:00.000Z",
  }));
  expect(
    autoAddRefusal({ ...mine, actions: [yes, ...yesterday] })
  ).toBeUndefined();
  // His own asks are not the auto-add permission's.
  const asked = three.map((a) => line("add", a.target, "connector:x"));
  expect(autoAddRefusal({ ...mine, actions: [yes, ...asked] })).toBeUndefined();
});

test("the auto-add permission is off once he removed a to-do item it added; removing one of his own asks leaves it on", () => {
  const made = line(
    "add",
    "reminder:7",
    "obs_000000000007",
    "2026-10-19T10:00:00.000Z"
  );
  const undo = line("remove", "reminder:7", "connector:y");
  expect(autoAddRefusal({ ...mine, actions: [yes, made, undo] })).toContain(
    "off"
  );
  // Moved to another list first (a new id), then removed: still his undo.
  const moved = {
    ...line("edit", "reminder:9", "connector:z"),
    before: { id: 7 },
  };
  expect(
    autoAddRefusal({
      ...mine,
      actions: [yes, made, moved, line("remove", "reminder:9", "connector:y")],
    })
  ).toContain("off");
  const own = line("add", "reminder:8", "connector:x");
  expect(
    autoAddRefusal({
      ...mine,
      actions: [yes, made, own, line("remove", "reminder:8", "connector:y")],
    })
  ).toBeUndefined();
});

test("the auto-add permission is off until his words in a session turn it on, off again on his no; a yes after an undo turns it back on", () => {
  const no = { ...yes, after: { on: false }, at: "2026-10-02T10:00:00.000Z" };
  expect(autoAddRefusal({ ...mine, actions: [] })).toContain("his own words");
  expect(autoAddRefusal({ ...mine, actions: [yes, no] })).toContain(
    "his own words"
  );
  const made = line(
    "add",
    "reminder:7",
    "obs_000000000007",
    "2026-10-03T10:00:00.000Z"
  );
  const undo = line(
    "remove",
    "reminder:7",
    "connector:y",
    "2026-10-04T10:00:00.000Z"
  );
  const again = { ...yes, at: "2026-10-05T10:00:00.000Z" };
  expect(autoAddRefusal({ ...mine, actions: [yes, made, undo] })).toContain(
    "undid"
  );
  expect(
    autoAddRefusal({ ...mine, actions: [yes, made, undo, again] })
  ).toBeUndefined();
});

test("the auto-add permission refuses a shared list, and fails closed when remctl does not say", () => {
  expect(unshared({ shared: false, sharees: [] })).toBe(true);
  expect(unshared({ shared: true, sharees: [{ name: "A" }] })).toBe(false);
  expect(unshared({ sharees: [{ name: "A" }] })).toBe(false);
  expect(unshared({})).toBe(false);
});

test("the same observation twice adds once: its standing add comes back, a failed one is tried again", () => {
  const made = line("add", "reminder:7", "obs_000000000007");
  expect(autoAddedFrom([made], "obs_000000000007")).toBe(made);
  expect(
    autoAddedFrom([{ ...made, result: "failed" }], "obs_000000000007")
  ).toBeUndefined();
  expect(autoAddedFrom([made], "obs_000000000008")).toBeUndefined();
});

test("the auto-add permission sets an add's title, named list, due and section only: no notes, link, subtasks or recurrence under its authority", () => {
  const add = { kind: "add", list: "Personal", title: "Call the plumber" };
  expect(AutoAdded.safeParse({ ...add, due: "2026-10-22" }).success).toBe(true);
  for (const bad of [
    { ...add, notes: "x" },
    { ...add, prompt: "x" },
    { ...add, recurrence: "daily" },
    { ...add, kind: "remove", target: 1 },
    { kind: "add", title: "no list" },
  ]) {
    expect(AutoAdded.safeParse(bad).success).toBe(false);
  }
});

test("with the actions output off, a change is refused before anything is recorded", async () => {
  const on = settings().todoList;
  const ledger = () => (existsSync(LEDGER) ? readFileSync(LEDGER, "utf8") : "");
  const before = ledger();
  setSettings({ todoList: null });
  try {
    await expect(
      changeAskedTodoItem(
        { kind: "add", said: "add milk", title: "Milk", why: "a test" },
        "session"
      )
    ).rejects.toThrow("To-do list is off");
    expect(ledger()).toBe(before);
  } finally {
    setSettings({ todoList: on });
  }
});
