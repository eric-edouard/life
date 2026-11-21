import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DAY, HOUR, MIN } from "../core/clock";
import { setSettings, settings } from "../core/settings";
import { DECISIONS } from "./decision-lines";
import { answerDecision, decisionsNow, requestDecision } from "./decisions";
import { Need } from "./needs";

// 21 Nov 2026 (his word): an agent's event is added to his calendar on his yes; never unasked.
const NOW = new Date("2026-11-18T09:00:00.000Z");
const EVENT = {
  end: "2026-12-01T12:00:00+07:00",
  kind: "event",
  place: "Blue Reef Diving, Chalong",
  reminders: [60, 1440],
  start: "2026-12-01T08:00:00+07:00",
  title: "Dive course, day 1",
};
const card = (over = {}) => ({
  context: "Kit confirmed the course by mail on 17 Nov.",
  deadline: new Date(NOW.getTime() + 2 * DAY).toISOString(),
  needs: [EVENT],
  onSilence: null,
  options: [
    { adds: true, id: "add", label: "Add to calendar" },
    { id: "no", label: "No" },
  ],
  question: "Add this to your calendar?",
  title: "Add the dive course",
  ...over,
});
const before = settings();
beforeEach(() => {
  rmSync(DECISIONS, { force: true });
  setSettings({
    ...before,
    appointmentsCalendar: { account: "me@example.com", calendar: "primary" },
  });
});
afterEach(() => setSettings(before));

test("an `event` card is checked when asked: one event with one `adds` option, ahead, never on silence or with another mark", async () => {
  const refused = (over: object, why: string) =>
    expect(requestDecision("planner", card(over), NOW)).rejects.toThrow(why);
  await refused(
    { options: card().options.slice(1).concat({ id: "x", label: "X" }) },
    "exactly one `adds`"
  );
  await refused(
    { needs: [{ ...EVENT, start: "2026-11-01T08:00:00+07:00" }] },
    "starts after the card"
  );
  await refused({ needs: [{ ...EVENT, reminders: [] }] }, "event");
  await refused({ onSilence: "add" }, "never takes an `adds`");
  await refused(
    {
      options: [
        { adds: true, id: "add", label: "Add", outgoing: true },
        { id: "no", label: "No" },
      ],
    },
    "no other mark"
  );
  expect(Need.safeParse({ ...EVENT, reminders: [1, 2, 3, 4] }).success).toBe(
    false
  );
  await requestDecision("planner", card(), NOW);
});

test("his pick of the `adds` option alone writes the event once; his words, a session or a second answer write nothing", async () => {
  const written: string[] = [];
  const add = (d: { id: string }) => {
    written.push(d.id);
    return Promise.resolve("gcal-1");
  };
  const { id } = await requestDecision("planner", card(), NOW);
  await expect(
    answerDecision(id, ["add"], undefined, {
      now: new Date(NOW.getTime() + HOUR),
    })
  ).rejects.toThrow("only on his own answer");
  const done = await answerDecision(id, ["add"], undefined, {
    add,
    now: new Date(NOW.getTime() + HOUR),
    via: "connector",
  });
  expect(done).toMatchObject([
    { kind: "answered" },
    { eventId: "gcal-1", id, kind: "added" },
  ]);
  await expect(
    answerDecision(id, ["add"], undefined, {
      add,
      now: new Date(NOW.getTime() + HOUR),
      via: "connector",
    })
  ).rejects.toThrow("answered");
  expect(written).toEqual([id]);
  expect(decisionsNow(NOW).find((d) => d.id === id)?.added?.eventId).toBe(
    "gcal-1"
  );
  const other = await requestDecision(
    "planner",
    card({ title: "Another" }),
    NOW
  );
  await answerDecision(other.id, ["add"], "Make it later", {
    add,
    now: new Date(NOW.getTime() + HOUR),
    via: "connector",
  });
  expect(written).toEqual([id]);
});

test("a failed write is recorded as the outcome and never retried", async () => {
  const { id } = await requestDecision("planner", card(), NOW);
  const done = await answerDecision(id, ["add"], undefined, {
    add: () => Promise.reject(new Error("the calendar is off")),
    now: new Date(NOW.getTime() + HOUR),
    via: "connector",
  });
  expect(done[1]).toMatchObject({
    error: "the calendar is off",
    kind: "added",
  });
  expect(decisionsNow(NOW).find((d) => d.id === id)?.state).toBe("answered");
});

test("the card refuses what he cannot act on: an event starting before the deadline, or with the calendar off", async () => {
  await expect(
    requestDecision(
      "planner",
      card({ deadline: new Date("2026-12-02T00:00:00Z").toISOString() }),
      NOW
    )
  ).rejects.toThrow("after the card's `deadline`");
  setSettings({ ...before, appointmentsCalendar: undefined });
  await expect(requestDecision("planner", card(), NOW)).rejects.toThrow(
    "calendar set up"
  );
});

test("an add that never ended reads as an error line after its limit, stays answered and is never retried", async () => {
  const { id } = await requestDecision("planner", card(), NOW);
  const hang = Promise.withResolvers<string>();
  const pending = answerDecision(id, ["add"], undefined, {
    add: () => hang.promise,
    now: new Date(NOW.getTime() + HOUR),
    via: "connector",
  });
  const read = decisionsNow(new Date(NOW.getTime() + HOUR + 3 * MIN)).find(
    (d) => d.id === id
  );
  expect(read?.added?.error).toContain("may not have been added");
  expect(read?.state).toBe("answered");
  hang.resolve("late");
  await pending;
});
