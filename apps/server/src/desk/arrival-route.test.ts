import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, MIN } from "../core/clock";
import { queuedEvents } from "../host/desk-read";
import type { Unit } from "../records/unit";
import {
  ARRIVAL_CONFIRMED,
  type ArrivalFacts,
  arrivalRouteOf,
  pollArrivals,
} from "./arrival-route";
import { readPeopleOnce } from "./desk-clock";
import { queue } from "./event-queue";
import { advance, asgOf, setup } from "./test-desk";

// A confirmed arrival's one wake. Made-up chat with Ana; the confirmed arrivals and units are given, not read.

afterEach(() => {
  setSystemTime();
});

const facts: ArrivalFacts = {
  at: "2026-11-18T09:00:00.000Z",
  chat: "Test Ana",
  id: "whatsapp:9",
  people: ["person:ana"],
  source: "whatsapp",
};
const none = { assignments: [], netPeople: [], personal: undefined };

test("one assignment: a waiting one first (the lowest id), else a matter's by its people, else Personal, else none", () => {
  expect(
    arrivalRouteOf(facts, { ...none, personal: "p", waiting: ["b", "a"] })
  ).toBe("a");
  const netPeople = [
    { assignment: "m2", people: new Set(["person:ana"]) },
    { assignment: "m1", people: new Set(["person:bo"]) },
  ];
  expect(
    arrivalRouteOf(facts, { ...none, netPeople, personal: "p", waiting: [] })
  ).toBe("m2");
  expect(arrivalRouteOf(facts, { ...none, personal: "p", waiting: [] })).toBe(
    "p"
  );
  expect(arrivalRouteOf(facts, { ...none, waiting: [] })).toBeUndefined();
});

const unitOf = (): Unit =>
  ({
    date: "2026-11-18",
    end: clock().toISOString(),
    hash: "0123456789abcdef",
    id: "unit_0000000000a1",
    key: "Test Ana",
    people: ["unknown:Ana"],
    refs: ["whatsapp:9"],
    schemaVersion: 1,
    source: "whatsapp",
    start: clock().toISOString(),
    stats: { chars: 10, fromMe: 0, items: 1 },
    title: "Ana",
  }) as Unit;

test("a waiting agent is woken once with the facts only; a message the desk already queued wakes no one again", async () => {
  const s = setup();
  const agent = await s.waiting();
  advance(5 * MIN);
  const arrival = {
    at: clock().toISOString(),
    messages: ["whatsapp|whatsapp:9"],
    unit: "unit_0000000000a1",
  };
  const poll = (messages = arrival.messages) =>
    pollArrivals(s.desk, readPeopleOnce(), {
      arrivals: [{ ...arrival, messages }],
      units: [unitOf()],
    });
  await poll();
  await poll();
  const woken = queuedEvents(s.desk.db, asgOf(s.desk, agent)).filter(
    (e) => e.name === ARRIVAL_CONFIRMED
  );
  expect(woken).toHaveLength(1);
  expect(Object.keys(JSON.parse(String(woken[0]?.payload))).sort()).toEqual([
    "at",
    "chat",
    "id",
    "people",
    "source",
  ]);
  queue(s.desk.db, "message.received", [
    { assignment: asgOf(s.desk, agent), eventId: "whatsapp:10", payload: {} },
  ]);
  await poll(["whatsapp|whatsapp:10"]);
  expect(
    queuedEvents(s.desk.db, asgOf(s.desk, agent)).filter(
      (e) => e.name === ARRIVAL_CONFIRMED
    )
  ).toHaveLength(1);
});
