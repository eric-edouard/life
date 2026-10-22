import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { unshared } from "../actions/remctl";
import { setSettings, settings } from "../core/settings";
import { ACTIONS } from "../memory/ledger";
import type { Action } from "../records/ledger";
import {
  actAsked,
  actionId,
  duplicateOf,
  Granted,
  grantedFrom,
  grantRefusal,
  requested,
} from "./act";

test("an add repeats an open reminder with the same title, whatever the case and accents; nothing else is a duplicate", () => {
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
  const id = actionId("job:1@t", "add", "Appeler le plombier");
  expect(actionId("job:1@t", "add", "  appelér le PLOMBIER ")).toBe(id);
  expect(actionId("job:2@t", "add", "Appeler le plombier")).not.toBe(id);
});

test("two requests the same day for the same edit both act: each has a ref of its own", () => {
  const id = (at: string) =>
    actionId(requested("session", "rename it", at).ref, "edit", "Same title");
  expect(id("2026-10-19T09:00:00.000Z")).not.toBe(
    id("2026-10-19T15:00:00.000Z")
  );
});

/** A ledger line of an add (the grant's when `ref` is an observation) or a remove. */
const line = (
  kind: "add" | "edit" | "remove" | "grant",
  target: string,
  ref: string,
  at = "2026-10-21T10:00:00.000Z"
): Action => ({
  // As `act` writes them: a removal leaves `deleted`, and each line has its own id.
  after: kind === "remove" ? { deleted: true } : {},
  at,
  id: actionId(ref, kind, target),
  instruction: { at, quote: "q", ref },
  kind,
  madeBy: "connector",
  result: "ok",
  schemaVersion: 1,
  target,
  why: "",
});
const NOW = "2026-10-21T12:00:00.000Z";
/** His yes, said in a Claude session before everything else here. */
const yes = {
  ...line("grant", "grant", "session:x", "2026-10-01T10:00:00.000Z"),
  after: { on: true },
};
const mine = {
  actions: [yes],
  list: { shared: false, sharees: [] },
  mine: true,
  now: NOW,
  o: {
    salience: 3,
    source: { channel: "lifelog" as const, ref: "job:3@2026-10-21T09:00:00Z" },
    type: "todo" as const,
  },
  state: "active",
};

test("the grant adds his own current salience-3 to-do from a turn lifelog credits to him, on a list nobody shares", () => {
  expect(grantRefusal(mine)).toBeUndefined();
  expect(
    grantRefusal({ ...mine, o: { ...mine.o, type: "promise" } })
  ).toBeUndefined();
});

test("the grant refuses a chat or mail observation, another speaker's or an unnamed turn, and anything not current, salient, a to-do or promise", () => {
  for (const channel of ["whatsapp", "mail"] as const) {
    expect(
      grantRefusal({
        ...mine,
        o: { ...mine.o, source: { channel, ref: "m1" } },
      })
    ).toContain("lifelog credits to his voice");
  }
  // Re-read at act time: someone else's turn, or one lifelog no longer names him on.
  expect(grantRefusal({ ...mine, mine: false })).toContain("his voice");
  expect(grantRefusal({ ...mine, state: "retired" })).toContain("not current");
  expect(grantRefusal({ ...mine, o: { ...mine.o, salience: 2 } })).toContain(
    "salience"
  );
  expect(grantRefusal({ ...mine, o: { ...mine.o, type: "idea" } })).toContain(
    "promises"
  );
});

test("the grant adds at most 3 in his day; the 4th is refused, yesterday's don't count", () => {
  const three = ["1", "2", "3"].map((n) =>
    line("add", `reminder:${n}`, `obs_00000000000${n}`)
  );
  expect(
    grantRefusal({ ...mine, actions: [yes, ...three.slice(0, 2)] })
  ).toBeUndefined();
  expect(grantRefusal({ ...mine, actions: [yes, ...three] })).toContain(
    "3 today"
  );
  const yesterday = three.map((a) => ({
    ...a,
    at: "2026-10-20T10:00:00.000Z",
  }));
  expect(
    grantRefusal({ ...mine, actions: [yes, ...yesterday] })
  ).toBeUndefined();
  // His own asks are not the grant's.
  const asked = three.map((a) => line("add", a.target, "connector:x"));
  expect(grantRefusal({ ...mine, actions: [yes, ...asked] })).toBeUndefined();
});

test("the grant is off once he removed a reminder it added; removing one of his own asks leaves it on", () => {
  const made = line(
    "add",
    "reminder:7",
    "obs_000000000007",
    "2026-10-19T10:00:00.000Z"
  );
  const undo = line("remove", "reminder:7", "connector:y");
  expect(grantRefusal({ ...mine, actions: [yes, made, undo] })).toContain(
    "off"
  );
  // Moved to another list first (a new id), then removed: still his undo.
  const moved = {
    ...line("edit", "reminder:9", "connector:z"),
    before: { id: 7 },
  };
  expect(
    grantRefusal({
      ...mine,
      actions: [yes, made, moved, line("remove", "reminder:9", "connector:y")],
    })
  ).toContain("off");
  const own = line("add", "reminder:8", "connector:x");
  expect(
    grantRefusal({
      ...mine,
      actions: [yes, made, own, line("remove", "reminder:8", "connector:y")],
    })
  ).toBeUndefined();
});

test("the grant is off until his words in a session turn it on, off again on his no; a yes after an undo turns it back on", () => {
  const no = { ...yes, after: { on: false }, at: "2026-10-02T10:00:00.000Z" };
  expect(grantRefusal({ ...mine, actions: [] })).toContain("his own words");
  expect(grantRefusal({ ...mine, actions: [yes, no] })).toContain(
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
  expect(grantRefusal({ ...mine, actions: [yes, made, undo] })).toContain(
    "undid"
  );
  expect(
    grantRefusal({ ...mine, actions: [yes, made, undo, again] })
  ).toBeUndefined();
});

test("the grant refuses a shared list, and fails closed when remctl does not say", () => {
  expect(unshared({ shared: false, sharees: [] })).toBe(true);
  expect(unshared({ shared: true, sharees: [{ name: "A" }] })).toBe(false);
  expect(unshared({ sharees: [{ name: "A" }] })).toBe(false);
  expect(unshared({})).toBe(false);
});

test("the same observation twice adds once: its standing add comes back, a failed one is tried again", () => {
  const made = line("add", "reminder:7", "obs_000000000007");
  expect(grantedFrom([made], "obs_000000000007")).toBe(made);
  expect(
    grantedFrom([{ ...made, result: "failed" }], "obs_000000000007")
  ).toBeUndefined();
  expect(grantedFrom([made], "obs_000000000008")).toBeUndefined();
});

test("the grant sets an add's title, named list, due and section only: no notes, link, subtasks or recurrence under its authority", () => {
  const add = { kind: "add", list: "Personal", title: "Call the plumber" };
  expect(Granted.safeParse({ ...add, due: "2026-10-22" }).success).toBe(true);
  for (const bad of [
    { ...add, notes: "x" },
    { ...add, prompt: "x" },
    { ...add, recurrence: "daily" },
    { ...add, kind: "remove", target: 1 },
    { kind: "add", title: "no list" },
  ]) {
    expect(Granted.safeParse(bad).success).toBe(false);
  }
});

test("with the actions output off, an act is refused before anything is recorded", async () => {
  const on = settings().actions;
  const ledger = () =>
    existsSync(ACTIONS) ? readFileSync(ACTIONS, "utf8") : "";
  const before = ledger();
  setSettings({ actions: null });
  try {
    await expect(
      actAsked(
        { kind: "add", said: "add milk", title: "Milk", why: "a test" },
        "session"
      )
    ).rejects.toThrow("Actions is off");
    expect(ledger()).toBe(before);
  } finally {
    setSettings({ actions: on });
  }
});
