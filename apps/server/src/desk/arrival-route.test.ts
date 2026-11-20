import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, MIN } from "../core/clock";
import { queuedEvents } from "../host/desk-read";
import type { Unit } from "../records/unit";
import {
  ARRIVAL_CONFIRMED,
  type ArrivalFacts,
  arrivalFactsOf,
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
test("an arrival of two people resolves each by its ref alone (regression: map's index reached refOf as `from`, crashing the desk)", () => {
  const refOf = (ref: string, ...rest: unknown[]) => {
    if (rest.length > 0) {
      throw new Error(`refOf got extra arguments: ${rest.join(",")}`);
    }
    return `person:${ref}`;
  };
  const got = arrivalFactsOf(
    {
      at: facts.at,
      messages: ["whatsapp|8", "whatsapp|9"],
      people: ["ana", "bo"],
    } as unknown as Parameters<typeof arrivalFactsOf>[0],
    { key: "Test Ana", source: "whatsapp" } as unknown as Unit,
    refOf
  );
  expect(got?.people).toEqual(["person:ana", "person:bo"]);
});

test("one assignment: a matter's whose people wrote the lines (the lowest id), else Personal, else none", () => {
  const netPeople = [
    { assignment: "m2", people: new Set(["person:ana"]) },
    { assignment: "m1", people: new Set(["person:bo"]) },
    { assignment: "m3", people: new Set(["person:ana"]) },
  ];
  expect(arrivalRouteOf(facts, { netPeople, personal: "p" })).toBe("m2");
  expect(arrivalRouteOf(facts, { netPeople: [], personal: "p" })).toBe("p");
  expect(
    arrivalRouteOf(facts, { netPeople: [], personal: undefined })
  ).toBeUndefined();
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

test("a message already queued for any agent wakes no one again; else Personal once, the facts only; no Personal, no wake", async () => {
  const s = setup();
  const agent = await s.waiting();
  advance(5 * MIN);
  const poll = (id: string) =>
    pollArrivals(s.desk, readPeopleOnce(), {
      arrivals: [
        {
          at: clock().toISOString(),
          messages: [`whatsapp|${id}`],
          people: ["person:ana"],
          unit: "unit_0000000000a1",
        },
      ],
      units: [unitOf()],
    });
  const woken = () =>
    queuedEvents(s.desk.db, asgOf(s.desk, agent)).filter(
      (e) => e.name === ARRIVAL_CONFIRMED
    );
  await poll("whatsapp:9");
  expect(woken()).toHaveLength(0);
  s.desk.db.run("update agent set is_personal = 1 where id = ?", [agent]);
  queue(s.desk.db, "message.received", [
    { assignment: asgOf(s.desk, agent), eventId: "whatsapp:9", payload: {} },
  ]);
  await poll("whatsapp:9");
  expect(woken()).toHaveLength(0);
  await poll("whatsapp:10");
  await poll("whatsapp:10");
  expect(woken()).toHaveLength(1);
  expect(Object.keys(JSON.parse(String(woken()[0]?.payload))).sort()).toEqual([
    "at",
    "chat",
    "id",
    "people",
    "source",
  ]);
});
