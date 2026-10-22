import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  actAsked,
  actionId,
  Change,
  duplicateOf,
  Granted,
  grantedFrom,
  grantRefusal,
  requested,
} from "./actions";
import { ACTIONS } from "./memory/ledger";
import { openOf, readable, unshared } from "./reminders/remctl";
import { alarmArgs, changedFields, reminderArgs } from "./reminders/write";
import type { Action } from "./schema";
import { setSettings, settings } from "./settings";

test("public fields go through EventKit, a timed reminder alerts at its time; section, urgent, subtasks and the link through the private helper", () => {
  expect(
    reminderArgs({ due: "2026-10-16", notes: "-- n", priority: "high" })
  ).toEqual({
    priv: [],
    pub: ["--notes=-- n", "--due=2026-10-16", "--priority=high"],
  });
  expect(reminderArgs({ recurrence: "monthly 6" }).pub).toEqual([
    "--recurrence=monthly 6",
  ]);
  // null clears the field (an edit); a missing field leaves it alone.
  expect(reminderArgs({ due: null, notes: null }).pub).toEqual([
    "--notes=",
    "--due=clear",
  ]);
  expect(reminderArgs({}).pub).toEqual([]);
  expect(
    reminderArgs({
      prompt: "Plan a trip & more",
      section: "Travel",
      subtasks: [
        { title: "Call" },
        { due: "2026-10-22", title: "Relancer si pas de réponse" },
        { due: "2026-10-22 09:00", title: "Rappeler" },
      ],
      urgent: true,
    }).priv
  ).toEqual([
    "--private",
    "--section=Travel",
    "--urgent",
    "--url=https://claude.ai/new?q=Plan%20a%20trip%20%26%20more",
    '--subtask={"title":"Call"}',
    '--subtask={"due":"2026-10-22","title":"Relancer si pas de réponse"}',
    '--subtask={"due":"2026-10-22 09:00","title":"Rappeler","alarm":"2026-10-22 09:00"}',
  ]);
});

test("a timed due alerts at its time, unless the reminder already has alarms (remctl moves those, his own stay)", () => {
  expect(alarmArgs("2026-10-18 08:30")).toEqual(["--alarm=2026-10-18 08:30"]);
  expect(alarmArgs("2026-10-18 08:30", true)).toEqual([]);
  expect(alarmArgs("2026-10-18")).toEqual([]);
  expect(alarmArgs(null)).toEqual([]);
});

test("an add repeats an open reminder with the same title, whatever the case and accents; nothing else is a duplicate", () => {
  const add = { kind: "add", title: "Dîner avec Gaston" } as const;
  const open = [{ completed: false, id: 9, title: " dîner AVEC gaston" }];
  expect(duplicateOf(add, open)).toBe("reminder:9");
  expect(
    duplicateOf({ ...add, title: "Dîner avec Jérôme" }, open)
  ).toBeUndefined();
  expect(duplicateOf({ ...add, kind: "edit" }, open)).toBeUndefined();
});

test("an open reminder keeps the six fields `open_reminders` promises, its due as a change takes it", () => {
  const r = {
    allDay: false,
    completed: false,
    deepLink: "x-apple-reminderkit://REMCDReminder/1",
    dueDate: "2026-10-22T09:30:00",
    flagged: false,
    id: 1,
    list: "Home",
    notes: "a\nb",
    section: "Soon",
    title: "Call the bank",
  };
  expect(openOf(r)).toEqual({
    due: "2026-10-22 09:30",
    id: 1,
    list: "Home",
    notes: "a\nb",
    section: "Soon",
    title: "Call the bank",
  });
  expect(
    openOf({ ...r, allDay: true, dueDate: "2026-10-22T00:00:00" }).due
  ).toBe("2026-10-22");
  expect(openOf({ ...r, dueDate: undefined }).due).toBeUndefined();
  // What it reads is what a change takes.
  expect(Change.shape.due.safeParse(openOf(r).due).success).toBe(true);
});

test("his reminders are read from one list or all, never the board", () => {
  expect(readable("Home")).toBe(true);
  expect(readable("Home", "Home")).toBe(true);
  expect(readable("Home", "Work")).toBe(false);
  expect(readable("Orbit")).toBe(false);
  expect(readable("Orbit", "Orbit")).toBe(false);
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

test("with Reminders off, an act is refused before anything is recorded", async () => {
  const on = settings().reminders;
  const ledger = () =>
    existsSync(ACTIONS) ? readFileSync(ACTIONS, "utf8") : "";
  const before = ledger();
  setSettings({ reminders: false });
  try {
    await expect(
      actAsked(
        { kind: "add", said: "add milk", title: "Milk", why: "a test" },
        "session"
      )
    ).rejects.toThrow("Reminders is off");
    expect(ledger()).toBe(before);
  } finally {
    setSettings({ reminders: on });
  }
});
