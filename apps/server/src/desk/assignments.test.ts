import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, DAY, HOUR, MIN } from "../core/clock";
import { gitOut } from "../core/proc";
import { setSettings, settings } from "../core/settings";
import {
  assignmentOf,
  assignmentOfCard,
  currentAssignmentOf,
} from "../host/desk-read";
import { decisionsNow } from "../memory/decisions";
import type { EventFilter } from "../records/registered-agent";
import {
  askDecision,
  openAssignment,
  openCardOf,
  register,
  setWait,
  withdrawOpenCards,
  writeNotes,
} from "./agent-actions";
import { pollMessages, readPeopleOnce, wakeDue } from "./desk-clock";
import { type Desk, writeWait } from "./desk-store";
import { agentWakesOf, routeOf, type WakeWhy } from "./event-queue";
import {
  ANA,
  advance,
  ahead,
  asgOf,
  matterView,
  on,
  setup,
  withMatters,
} from "./test-desk";

// Assignments of one agent keep apart (agents and matters, PR 1): a turn consumes only its own assignment's events, and
// nothing from before an assignment was opened is new to it.

afterEach(() => {
  setSystemTime();
});

test("a turn on one assignment never consumes another's events", async () => {
  const { desk, end, waiting } = setup();
  const id = await waiting();
  const first = asgOf(desk, id);
  const second = openAssignment(desk, id, {
    openedBy: "owner",
    steps: ["obs_test_b"],
  });
  for (const [assignment, eventId] of [
    [first, "e1"],
    [second, "e2"],
  ] as const) {
    desk.db.run(
      "insert into event (assignment_id, event_id, name, payload, received_at) values (?, ?, 'message.received', '{}', ?)",
      [assignment, eventId, clock().toISOString()]
    );
  }
  advance(HOUR);
  await wakeDue(desk);
  // The agent's one turn runs on one of the two; it ends with its set_wait.
  const ran = desk.db
    .query<{ assignment_id: string }, []>(
      "select assignment_id from turn order by id desc limit 1"
    )
    .get()?.assignment_id;
  await setWait(desk, on(desk, id), {
    events: [],
    reason: "r",
    until: ahead(HOUR),
  });
  await end(id);
  const [mine, other] = ran === first ? ["e1", "e2"] : ["e2", "e1"];
  const row = (eventId: string) =>
    desk.db
      .query<{ consumed_at: string | null; handed: number }, [string]>(
        "select handed, consumed_at from event where event_id = ?"
      )
      .get(eventId);
  expect(row(mine)?.consumed_at).not.toBeNull();
  expect(row(other)).toEqual({ consumed_at: null, handed: 0 });
});

test("an event from before an assignment was opened never wakes it", async () => {
  const { desk, waiting } = setup();
  const id = await waiting();
  const mine = currentAssignmentOf(desk.db, id);
  const event = (eventId: string, at: string) => ({
    at,
    eventId,
    matchable: { channel: "whatsapp", chat: "Test Ana", fromMe: false },
    payload: {},
  });
  const wakes = (e: ReturnType<typeof event>) =>
    agentWakesOf(desk.db, mine ? [mine] : [], {} as never, [e]);
  // `waiting` opened the assignment now, T0: an event a minute older was heard before it.
  expect(wakes(event("before", ahead(-MIN)))).toEqual([]);
  expect(wakes(event("after", ahead(MIN)))).toEqual([
    { assignment: mine?.id ?? "", eventId: "after", payload: {} },
  ]);
});

// A turn names one matter; an event goes to one assignment per agent (agents and matters, PR 2). Made-up agents,
// matters, chats and notes; a second assignment on one agent is opened by hand.

const MATTERS = [
  matterView("mat_a", ["obs_a1"]),
  matterView("mat_b", ["obs_b1"]),
];

/** A second assignment of agent `id`, on matter `mat_<x>`, waiting for `events` until `until`, with its notes. */
function onMatter(
  desk: Desk,
  id: string,
  x: string,
  until: number,
  events: EventFilter[] = []
) {
  const s = openAssignment(desk, id, {
    openedBy: "owner",
    steps: [`obs_${x}1`],
  });
  writeWait(desk.db, s, { events, reason: "r", until: ahead(until) }, false);
  const row = assignmentOf(desk.db, s);
  if (row) {
    writeNotes(desk, row, `Notes of matter ${x}`);
  }
  return s;
}

test("routeOf: one wake per event and agent; a matter's wait, the agent's own, a person, then meaning (the closer first), then the first opened; another agent keeps its own", () => {
  const holders = new Map([
    ["own", { agent: "a", isOwn: true, openedAt: "1" }],
    ["m1", { agent: "a", isOwn: false, openedAt: "2" }],
    ["m2", { agent: "a", isOwn: false, openedAt: "3" }],
    ["b", { agent: "b", isOwn: true, openedAt: "1" }],
  ]);
  const wake = (assignment: string, by: WakeWhy, eventId = "e") => ({
    assignment,
    by,
    eventId,
  });
  const route = (...wakes: ReturnType<typeof wake>[]) =>
    routeOf(wakes, holders).map((w) => `${w.eventId}:${w.assignment}`);
  const meaning = (similarity: number) =>
    ({ similarity, why: "meaning" }) as const;
  expect(
    route(
      wake("m2", meaning(0.9)),
      wake("own", { why: "wait" }),
      wake("m1", { why: "wait" })
    )
  ).toEqual(["e:m1"]);
  expect(route(wake("m1", meaning(0.9)), wake("own", { why: "wait" }))).toEqual(
    ["e:own"]
  );
  expect(
    route(wake("m1", meaning(0.9)), wake("m2", { why: "person" }))
  ).toEqual(["e:m2"]);
  expect(route(wake("m1", meaning(0.6)), wake("m2", meaning(0.7)))).toEqual([
    "e:m2",
  ]);
  expect(
    route(wake("m2", { why: "person" }), wake("m1", { why: "person" }))
  ).toEqual(["e:m1"]);
  expect(
    route(
      wake("m1", { why: "wait" }),
      wake("b", { why: "wait" }),
      wake("m2", { why: "wait" }, "f")
    )
  ).toEqual(["e:m1", "e:b", "f:m2"]);
});

// Regression: an event two waits of one agent want is one wake, for its matter; another agent listening is woken too.
test("a message two waits of one agent match is queued once, for its matter; a second agent waiting for it is woken too", async () => {
  const { desk, waiting, write } = setup();
  desk.embedder = null;
  const id = await waiting();
  const other = await waiting();
  const matter = onMatter(desk, id, "a", HOUR, [ANA]);
  await withMatters(MATTERS, async () => {
    await pollMessages(desk, readPeopleOnce());
    advance(MIN);
    const m = write();
    await pollMessages(desk, readPeopleOnce());
    const queuedFor = (eventId: string) =>
      desk.db
        .query<{ assignment_id: string }, [string]>(
          "select assignment_id from event where event_id = ? order by assignment_id"
        )
        .all(eventId)
        .map((r) => r.assignment_id);
    expect(queuedFor(m)).toEqual([matter, asgOf(desk, other)].toSorted());
  });
});

// Regression: one agent's assignments wake on their own deadlines, one at a time, each wake naming its matter.
test("an assignment whose deadline passes gets a deadline turn naming its matter, with its record and its notes only, while the agent's other assignment waits; then the other", async () => {
  const { desk, end, fake, waiting } = setup();
  const id = await waiting(3 * HOUR);
  const a = onMatter(desk, id, "a", HOUR);
  const b = onMatter(desk, id, "b", HOUR + 30 * MIN);
  await withMatters(MATTERS, async () => {
    advance(2 * HOUR);
    await wakeDue(desk);
    const turns = () =>
      desk.db
        .query<{ assignment_id: string; cause: string }, []>(
          "select assignment_id, cause from turn order by id"
        )
        .all();
    // One turn at a time: b is due too, and waits for a's to end.
    expect(turns().slice(1)).toEqual([{ assignment_id: a, cause: "deadline" }]);
    const wake = fake.said.at(-1)?.message ?? "";
    expect(wake).toContain("Woken by the desk: deadline.");
    expect(wake).toContain('"id":"mat_a"');
    expect(wake).toContain("Next step of mat_a");
    expect(wake).toContain("Notes of matter a");
    expect(wake).not.toContain("mat_b");
    expect(wake).not.toContain("Notes of matter b");
    expect(wake).not.toContain("sweep what happened");
    await setWait(desk, on(desk, id), {
      events: [],
      reason: "r",
      until: ahead(DAY),
    });
    await end(id);
    await wakeDue(desk);
    expect(turns().slice(2)).toEqual([{ assignment_id: b, cause: "deadline" }]);
    expect(fake.said.at(-1)?.message).toContain("Notes of matter b");
  });
});

test("a matter's card takes its first step as subject, refuses another matter's, and his answer is queued for that assignment", async () => {
  const { desk, waiting } = setup();
  const id = await waiting();
  const a = onMatter(desk, id, "a", HOUR);
  const row = assignmentOf(desk.db, a);
  if (!row) {
    throw new Error("no assignment");
  }
  const card = (subject?: string) => ({
    deadline: ahead(DAY),
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    question: "Test: order it?",
    title: "a test",
    ...(subject ? { subject } : {}),
  });
  await withMatters(MATTERS, async () => {
    await expect(askDecision(desk, row, card("obs_b1"))).rejects.toThrow(
      "not your matter's (mat_a)"
    );
    const { id: asked } = await askDecision(desk, row, card());
    const d = decisionsNow().find((x) => x.id === asked);
    expect(d?.subject).toBe("obs_a1");
    expect(assignmentOfCard(desk.db, d ?? {})).toBe(a);
    // The agent's own assignment has no card yet: its own first card is its own.
    expect(openCardOf(desk.db, on(desk, id))).toBeUndefined();
    await withdrawOpenCards(desk.db, row, "test over");
  });
});

test("after a turn the desk commits the agent's home and the assignment's folder in his agents repo", async () => {
  const repo = mkdtempSync(join(tmpdir(), "life-agents-"));
  gitOut(repo, ["init", "-q"]);
  gitOut(repo, ["config", "user.email", "test@example.test"]);
  gitOut(repo, ["config", "user.name", "Test"]);
  mkdirSync(join(repo, "project-test-bakery"));
  writeFileSync(join(repo, "project-test-bakery", "AGENTS.md"), "Test rules");
  writeFileSync(join(repo, "elsewhere.md"), "not the desk's");
  const was = settings().desk;
  setSettings({ desk: { agentsRepo: repo, runtimes: {} } });
  try {
    const { desk, end } = setup();
    const id = register(desk, {
      brief: "Test brief",
      project: "test-bakery",
      runtime: "fake",
    });
    await wakeDue(desk);
    writeNotes(desk, on(desk, id), "Test notes");
    await setWait(desk, on(desk, id), {
      events: [],
      reason: "r",
      until: ahead(HOUR),
    });
    await end(id);
    expect(gitOut(repo, ["log", "--format=%s"])).toBe(
      `desk: ${id}'s turn on ${asgOf(desk, id)}`
    );
    expect(
      gitOut(repo, ["show", "--name-only", "--format="]).split("\n").toSorted()
    ).toEqual([
      `assignments/${asgOf(desk, id)}/NOTES.md`,
      "project-test-bakery/AGENTS.md",
    ]);
  } finally {
    setSettings({ desk: was ?? null });
  }
});
