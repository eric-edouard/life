import { expect, test } from "bun:test";
import {
  actionId,
  alarmArgs,
  changedFields,
  duplicateOf,
  reminderArgs,
  requested,
} from "./actions";

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
  expect(duplicateOf(add, undefined)).toBeUndefined();
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
