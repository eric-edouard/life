import { afterEach, expect, setSystemTime, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { clock, daysBefore, MIN } from "../core/clock";
import { logEvents, logFileOf } from "../core/log";
import { setSettings } from "../core/settings";
import { queuedEvents } from "../host/desk-read";
import { UNITS } from "../memory/memory-files";
import { dayStart, localDate } from "../memory/zones";
import type { Unit } from "../records/unit";
import {
  ARRIVAL_CONFIRMED,
  type ArrivalFacts,
  arrivalFactsOf,
  arrivalNetsOf,
  pollArrivals,
} from "./arrival-route";
import { readPeopleOnce } from "./desk-clock";
import { matterOrPersonalOf, queue } from "./event-queue";
import { PERSONAL_BRIEF, standingAgentOf } from "./role-agents";
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
  const nets = [
    { assignment: "m2", people: new Set(["person:ana"]) },
    { assignment: "m1", people: new Set(["person:bo"]) },
    { assignment: "m3", people: new Set(["person:ana"]) },
  ];
  expect(matterOrPersonalOf(arrivalNetsOf(facts, nets), "p")).toBe("m2");
  expect(matterOrPersonalOf(arrivalNetsOf(facts, []), "p")).toBe("p");
  expect(
    matterOrPersonalOf(arrivalNetsOf(facts, []), undefined)
  ).toBeUndefined();
  // A person beats meaning; among meanings the closest.
  expect(
    matterOrPersonalOf(
      [
        { assignment: "a", by: { similarity: 0.7, why: "meaning" } },
        { assignment: "b", by: { similarity: 0.9, why: "meaning" } },
      ],
      "p"
    )
  ).toBe("b");
  expect(
    matterOrPersonalOf(
      [
        { assignment: "b", by: { similarity: 0.9, why: "meaning" } },
        { assignment: "c", by: { why: "person" } },
      ],
      "p"
    )
  ).toBe("c");
});

test("the first arrival no matter's agent takes, with no agent at all, starts the Personal agent once; a stopped one is never doubled and holds it back", async () => {
  const s = setup();
  s.desk.runtimes.claude = s.fake.runtime;
  setSettings({ desk: { defaultRuntime: "claude", runtimes: {} } });
  try {
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
    await poll("whatsapp:1");
    await poll("whatsapp:2");
    const personal = standingAgentOf(s.desk.db, "personal");
    expect(personal?.brief).toBe(PERSONAL_BRIEF);
    const asg = asgOf(s.desk, personal?.id ?? "");
    expect(
      queuedEvents(s.desk.db, asg)
        .filter((e) => e.name === ARRIVAL_CONFIRMED)
        .map((e) => e.event_id)
    ).toEqual(["whatsapp:1", "whatsapp:2"]);
    s.desk.db.run("update agent set status = 'stopped' where id = ?", [
      personal?.id ?? "",
    ]);
    await poll("whatsapp:3");
    expect(
      s.desk.db
        .query<{ n: number }, []>(
          "select count(*) as n from agent where role = 'personal'"
        )
        .get()?.n
    ).toBe(1);
    expect(
      s.desk.db.query("select 1 from event where event_id = 'whatsapp:3'").all()
    ).toEqual([]);
  } finally {
    setSettings({ desk: null });
  }
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
  s.desk.db.run("update agent set role = 'personal' where id = ?", [agent]);
  queue(s.desk.db, "message.received", [
    { assignment: asgOf(s.desk, agent), eventId: "whatsapp:9", payload: {} },
  ]);
  await poll("whatsapp:9");
  expect(woken()).toHaveLength(0);
  await poll("whatsapp:10");
  await poll("whatsapp:10");
  expect(woken()).toHaveLength(1);
  // Each wake queued is one log line; one refused as already queued is none.
  expect(
    logEvents(logFileOf(clock().toISOString()), "desk.queued")
      .filter((l) => l.assignment === asgOf(s.desk, agent))
      .map((l) => [l.event, l.eventId])
  ).toEqual([
    ["message.received", "whatsapp:9"],
    [ARRIVAL_CONFIRMED, "whatsapp:10"],
  ]);
  expect(Object.keys(JSON.parse(String(woken()[0]?.payload))).sort()).toEqual([
    "at",
    "chat",
    "id",
    "people",
    "source",
  ]);
});

test("a desk tick's confirmed arrivals of several people, from chat, mail and voice, each wake Personal once with its facts", async () => {
  const s = setup();
  const agent = await s.waiting();
  s.desk.db.run("update agent set role = 'personal' where id = ?", [agent]);
  advance(5 * MIN);
  const unit = (id: string, source: Unit["source"], key: string): Unit => ({
    ...unitOf(),
    id,
    key,
    source,
  });
  const turn = "job7:4@2026-11-18T09:01:00.000Z";
  const arrivalOf = (unitId: string, messages: string[]) => ({
    at: clock().toISOString(),
    messages,
    people: ["person:ana", "unknown:Bo"],
    unit: unitId,
  });
  await pollArrivals(s.desk, readPeopleOnce(), {
    arrivals: [
      arrivalOf("unit_0000000000c1", [
        "whatsapp|whatsapp:1",
        "whatsapp|whatsapp:2",
      ]),
      arrivalOf("unit_0000000000c2", [
        "mail|<m1@example.test>",
        "mail|<m2@example.test>",
      ]),
      arrivalOf("unit_0000000000c3", [
        "lifelog|job7:3@2026-11-18T09:00:30.000Z",
        `lifelog|${turn}`,
      ]),
    ],
    units: [
      unit("unit_0000000000c1", "whatsapp", "120363000000000002@g.us"),
      unit("unit_0000000000c2", "mail", "thread-1"),
      unit("unit_0000000000c3", "lifelog", "conversation-1"),
    ],
  });
  const woken = queuedEvents(s.desk.db, asgOf(s.desk, agent))
    .filter((e) => e.name === ARRIVAL_CONFIRMED)
    .map((e) => JSON.parse(String(e.payload)) as ArrivalFacts);
  expect(woken.map((f) => [f.source, f.id, f.people.length])).toEqual([
    ["whatsapp", "whatsapp:2", 2],
    ["mail", "<m2@example.test>", 2],
    ["lifelog", turn, 2],
  ]);
});

/** A confirm `confirmedAgo` before a poll `minutes` into today, of a voice unit `days` before today: woken or not. */
async function wokenFor(minutes: number, days: number, confirmedAgo: number) {
  const s = setup();
  const agent = await s.waiting();
  s.desk.db.run("update agent set role = 'personal' where id = ?", [agent]);
  setSystemTime(
    dayStart(localDate(clock().toISOString())).getTime() + minutes * MIN
  );
  const day = daysBefore(localDate(clock().toISOString()), days);
  const turn = `job8:2@${dayStart(day).toISOString()}`;
  // The test data is shared: the day's file is put back as it was.
  const file = join(UNITS, `${day}.jsonl`);
  const was = existsSync(file) ? readFileSync(file, "utf8") : null;
  mkdirSync(UNITS, { recursive: true });
  appendFileSync(
    file,
    `${JSON.stringify({ ...unitOf(), date: day, id: "unit_0000000000d1", key: "conversation-2", source: "lifelog" })}\n`
  );
  try {
    await pollArrivals(s.desk, readPeopleOnce(), {
      arrivals: [
        {
          at: new Date(clock().getTime() - confirmedAgo).toISOString(),
          messages: [`lifelog|${turn}`],
          people: ["person:ana"],
          unit: "unit_0000000000d1",
        },
      ],
    });
  } finally {
    if (was === null) {
      rmSync(file);
    } else {
      writeFileSync(file, was);
    }
  }
  return queuedEvents(s.desk.db, asgOf(s.desk, agent)).filter(
    (e) => e.name === ARRIVAL_CONFIRMED
  ).length;
}

test("a confirm of yesterday's voice finds its unit and wakes: made this afternoon, just before a midnight polled after it, or just after one polled at noon", async () => {
  expect(await wokenFor(15 * 60, 1, 0)).toBe(1);
  // Polled at 00:01, confirmed at 23:59 of a unit of the day before.
  expect(await wokenFor(1, 2, 2 * MIN)).toBe(1);
  // Polled at 12:01, confirmed at 00:02 of a unit of the day before yesterday (a pass begun at 23:59).
  expect(await wokenFor(12 * 60 + 1, 2, 719 * MIN)).toBe(1);
});
