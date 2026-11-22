import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
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
import type { Descriptor } from "../sources/contract";
import { insertAgent } from "./agent-actions";
import {
  ARRIVAL_CONFIRMED,
  type ArrivalFacts,
  arrivalFactsOf,
  arrivalNetsOf,
  hasAnsweredOf,
  pollArrivals,
} from "./arrival-route";
import { readPeopleOnce } from "./desk-clock";
import { matterOrPersonalOf, queue } from "./event-queue";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as matterNet from "./matter-net";
import {
  PERSONAL_BRIEF,
  roleAssignmentOf,
  standingAgentOf,
} from "./role-agents";
import { advance, ahead, asgOf, setup } from "./test-desk";

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

test("no Personal agent is registered while the start is blocked or the desk is full", () => {
  const s = setup();
  const place = (blocked?: string) =>
    roleAssignmentOf(s.desk, "personal", PERSONAL_BRIEF, blocked);
  expect(place("the runtime is signed out")).toEqual({
    why: "the runtime is signed out",
  });
  for (let i = 0; i < 50; i += 1) {
    insertAgent(s.desk.db, { brief: "b", runtime: "claude" });
  }
  expect(place()).toEqual({ why: "the desk keeps 50 agents active at most" });
  expect(standingAgentOf(s.desk.db, "personal")).toBeUndefined();
});

/** A desk with one matter's agent whose net holds Ana, polled with arrivals of `[id, people, at]`; Personal runs on `claude`. */
async function matterDesk(agentsRepo?: string) {
  const s = setup();
  const agent = await s.waiting();
  const asg = asgOf(s.desk, agent);
  s.desk.runtimes.claude = s.fake.runtime;
  setSettings({
    desk: { agentsRepo, defaultRuntime: "claude", runtimes: {} },
  });
  const nets = spyOn(matterNet, "netsOf").mockResolvedValue([
    { assignment: asg, people: new Set(["person:ana"]), vectors: [] },
  ] as never);
  const poll = (list: [string, string, string][]) =>
    pollArrivals(s.desk, readPeopleOnce(), {
      arrivals: list.map(([id, person, at]) => ({
        at,
        messages: [`whatsapp|${id}`],
        people: [person],
        unit: "unit_0000000000a1",
      })),
      units: [unitOf()],
    });
  const queuedIds = () =>
    s.desk.db
      .query<{ event_id: string }, []>("select event_id from event")
      .all()
      .map((r) => r.event_id);
  const done = () => {
    nets.mockRestore();
    setSettings({ desk: null });
  };
  return { asg, done, poll, queuedIds, s };
}

test("in one poll, a matter's arrival is queued though the Personal agent cannot be registered, whose arrival waits; none goes onto a closed assignment", async () => {
  // Personal's home cannot be made: its registration throws.
  const d = await matterDesk("/dev/null/agents");
  try {
    const now = clock().toISOString();
    await d.poll([
      ["whatsapp:1", "person:ana", now],
      ["whatsapp:2", "person:bo", now],
    ]);
    expect(d.queuedIds()).toEqual(["whatsapp:1"]);
    expect(standingAgentOf(d.s.desk.db, "personal")).toBeUndefined();
    d.s.desk.db.run("update assignment set closed_at = ? where id = ?", [
      now,
      d.asg,
    ]);
    await d.poll([["whatsapp:3", "person:ana", now]]);
    expect(d.queuedIds()).toEqual(["whatsapp:1"]);
  } finally {
    d.done();
  }
});

test("a Personal agent that never began is tried again only for a Personal arrival newer than its end, never for a matter's", async () => {
  const d = await matterDesk();
  try {
    const { db } = d.s.desk;
    const ended = clock().toISOString();
    const failed = insertAgent(db, {
      brief: "b",
      role: "personal",
      runtime: "claude",
    }).id;
    db.run("update agent set status = 'ended', ended_at = ? where id = ?", [
      ended,
      failed,
    ]);
    db.run(
      "insert into assignment (id, agent_id, opened_at, opened_by, wait_until, wait_reason, notes_path, closed_at, why_not_started) values ('asg_failed', ?1, ?2, 'owner', ?2, 'first turn', 'n', ?2, 'signed out')",
      [failed, ended]
    );
    await d.poll([
      ["whatsapp:1", "person:bo", ahead(-MIN)],
      ["whatsapp:2", "person:ana", ahead(MIN)],
    ]);
    expect(d.queuedIds()).toEqual(["whatsapp:2"]);
    expect(standingAgentOf(db, "personal")).toBeUndefined();
  } finally {
    d.done();
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

test("he answered after an arrival's newest line: no agent wakes; a line of his before it, or none, still wakes", async () => {
  const at = "2026-11-18T09:05:00.000Z";
  const line = (id: string, minute: number, fromMe: boolean) => ({
    at: `2026-11-18T09:0${minute}:00.000Z`,
    fromMe,
    id,
  });
  const f = { at, id: "whatsapp:9" };
  expect(
    hasAnsweredOf([line("whatsapp:9", 1, false), line("w:10", 2, true)], f)
  ).toBe(true);
  expect(
    hasAnsweredOf([line("w:8", 0, true), line("whatsapp:9", 1, false)], f)
  ).toBe(false);
  // His own newest line is a commitment: his next line never answers it.
  expect(
    hasAnsweredOf([line("whatsapp:9", 1, true), line("w:10", 2, true)], f)
  ).toBe(false);
  // The newest line unseen: only a line of his after the confirm counts.
  expect(hasAnsweredOf([line("w:10", 2, true)], f)).toBe(false);

  const s = setup();
  s.desk.runtimes.claude = s.fake.runtime;
  setSettings({ desk: { defaultRuntime: "claude", runtimes: {} } });
  try {
    const now = clock();
    const event = (id: string, fromMe: boolean, minutes: number) => ({
      at: new Date(now.getTime() - minutes * MIN).toISOString(),
      chat: "Test Ana",
      fromMe,
      id,
      sender: fromMe ? "me" : "ana",
      source: "whatsapp" as const,
      text: "x",
    });
    const chat = {
      kind: "chat",
      label: "WhatsApp",
      name: "whatsapp",
      read: () => [event("whatsapp:1", false, 3), event("whatsapp:2", true, 1)],
      silentAfter: 1,
    } as unknown as Descriptor;
    await pollArrivals(s.desk, readPeopleOnce(), {
      arrivals: [
        {
          at: now.toISOString(),
          messages: ["whatsapp|whatsapp:1"],
          people: ["person:ana"],
          unit: "unit_0000000000a1",
        },
      ],
      sources: [chat],
      units: [unitOf()],
    });
    expect(standingAgentOf(s.desk.db, "personal")).toBeUndefined();
    expect(
      s.desk.db.query("select 1 from event where event_id = 'whatsapp:1'").all()
    ).toEqual([]);
    // life#1099: a mail he answered in its thread wakes no one either.
    const mail = {
      ...chat,
      kind: "mail",
      name: "mail",
      read: () => [
        { ...event("mail:1", false, 3), chat: "mail:7", source: "mail" },
        { ...event("mail:2", true, 1), chat: "mail:7", source: "mail" },
      ],
    } as unknown as Descriptor;
    await pollArrivals(s.desk, readPeopleOnce(), {
      arrivals: [
        {
          at: now.toISOString(),
          messages: ["mail|mail:1"],
          people: ["person:ana"],
          unit: "unit_0000000000a2",
        },
      ],
      sources: [mail],
      units: [
        { ...unitOf(), id: "unit_0000000000a2", key: "mail:7", source: "mail" },
      ],
    });
    expect(standingAgentOf(s.desk.db, "personal")).toBeUndefined();
  } finally {
    setSettings({ desk: null });
  }
});
