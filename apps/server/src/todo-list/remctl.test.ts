import { expect, test } from "bun:test";
import { alarmArgs, reminderArgs } from "./remctl";

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
