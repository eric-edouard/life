import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, DAY, HOUR, MIN } from "../core/clock";
import { gitOut } from "../core/proc";
import { setSettings, settings } from "../core/settings";
import {
  agentOf,
  anchorsOf,
  assignmentOf,
  assignmentOfCard,
  currentAssignmentOf,
  handedSteps,
  openTurn,
  queuedEvents,
} from "../host/desk-read";
import { answerDecision, decisionsNow } from "../memory/decisions";
import type { EventFilter } from "../records/registered-agent";
import {
  askDecision,
  closeAssignment,
  hasAsked,
  openAssignment,
  pendingCardOf,
  register,
  setWait,
  withdrawOpenCards,
  writeNotes,
  writeSubject,
} from "./agent-actions";
import {
  pollAnswers,
  pollMessages,
  readPeopleOnce,
  wakeDue,
} from "./desk-clock";
import { type Desk, openDesk, writeWait } from "./desk-store";
import { agentWakesOf, routeOf, type WakeWhy } from "./event-queue";
import {
  ANA,
  advance,
  ahead,
  asgOf,
  matterView,
  on,
  setup,
  started,
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
  matterView("mat_a", ["obs_a1", "obs_a2"]),
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

test("a matter's card takes its matter as subject (stored as its newest step), refuses another matter's, and his answer is queued for that assignment", async () => {
  const { desk, waiting } = setup();
  const id = await waiting();
  const a = onMatter(desk, id, "a", HOUR);
  const row = assignmentOf(desk.db, a);
  if (!row) {
    throw new Error("no assignment");
  }
  const card = (subject?: string) => ({
    context: "A made-up reason to ask.",
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
      "is not on a matter you hold"
    );
    const { id: asked } = await askDecision(desk, row, card());
    const d = decisionsNow().find((x) => x.id === asked);
    expect(d?.subject).toBe("obs_a2");
    expect(assignmentOfCard(desk.db, d ?? { id: asked })).toBe(a);
    // The agent's own assignment has no card yet: its own first card is its own.
    expect(pendingCardOf(desk.db, on(desk, id))).toBeUndefined();
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

// The verdict's rework on PR 2: ownership is enforced where a card or a turn's outcome is written. Made-up agent,
// matters and cards; `own` is the agent's own assignment, `onA` its assignment on a made-up matter.

const yesNo = (subject?: string) => ({
  context: "A made-up reason to ask.",
  deadline: ahead(DAY),
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  question: "Test: order it?",
  title: "a test",
  ...(subject ? { subject } : {}),
});

async function twoAssignments() {
  const t = setup();
  const id = await t.waiting(3 * HOUR);
  const a = onMatter(t.desk, id, "a", HOUR);
  const row = (s: string) => {
    const r = assignmentOf(t.desk.db, s);
    if (!r) {
      throw new Error(`no ${s}`);
    }
    return r;
  };
  return { ...t, id, onA: () => row(a), own: () => row(asgOf(t.desk, id)) };
}

// Regression: a turn could withdraw the card of another assignment of its agent.
test("a turn cannot withdraw the card of its agent's other assignment", async () => {
  const { desk, onA, own } = await twoAssignments();
  await withMatters(MATTERS, async () => {
    const { id: card } = await askDecision(desk, onA(), yesNo());
    await expect(
      askDecision(desk, own(), { why: "test", withdraw: card })
    ).rejects.toThrow("is not a card of this turn's assignment");
    expect(decisionsNow().find((d) => d.id === card)?.state).toBe("open");
    await withdrawOpenCards(desk.db, onA(), "test over");
  });
});

// Regression: a card's owner was worked out from anchors, so a step its agent's other assignment was handed later took
// the card over: its answer and its withdrawal. The desk now writes once which assignment asked it.
test("a card stays its asking assignment's when its subject is later anchored on the agent's other one; his answer wakes the asker", async () => {
  const t = await twoAssignments();
  const { desk, onA } = t;
  const b = assignmentOf(desk.db, onMatter(desk, t.id, "b", HOUR));
  if (!b) {
    throw new Error("no assignment on b");
  }
  const own = () => b;
  await withMatters(MATTERS, async () => {
    pollAnswers(desk);
    const { id: card } = await askDecision(desk, own(), yesNo("obs_b1"));
    desk.db.run(
      "insert into anchor (assignment_id, step, added_at) values (?, 'obs_b1', ?)",
      [onA().id, clock().toISOString()]
    );
    await expect(
      askDecision(desk, onA(), { why: "test", withdraw: card })
    ).rejects.toThrow("is not a card of this turn's assignment");
    advance(1000);
    await answerDecision(card, ["yes"]);
    advance(1000);
    pollAnswers(desk);
    const answered = (s: string) =>
      queuedEvents(desk.db, s).map((e) => e.event_id);
    expect(answered(own().id)).toEqual([`${card}.answered`]);
    expect(answered(onA().id)).toEqual([]);
    expect(hasAsked(desk.db, onA())).toBe(false);
  });
});

// Regression: closing one assignment marked its agent's running turn on another as finished.
test("closing one assignment during a turn on another leaves that turn and its events as they were", async () => {
  const { desk, end, id, onA, own } = await twoAssignments();
  advance(3 * HOUR + MIN);
  desk.db.run("delete from turn where assignment_id = ?", [onA().id]);
  const ownEvent = "test-own-event";
  desk.db.run(
    "insert into event (assignment_id, event_id, name, payload, received_at, handed) values (?, ?, 'message.received', '{}', ?, 1)",
    [own().id, ownEvent, clock().toISOString()]
  );
  desk.db.run(
    "insert into turn (agent_id, assignment_id, session, cause, started_at, begun_at) values (?, ?, ?, 'event', ?, ?)",
    [
      id,
      own().id,
      agentOf(desk.db, id)?.session ?? null,
      clock().toISOString(),
      clock().toISOString(),
    ]
  );
  await closeAssignment(desk, onA().id, "test: its matter is done");
  expect(openTurn(desk.db, id)?.outcome).toBeNull();
  await end(id);
  // Reminded, not ended: its handed event is still its own to act on.
  expect(openTurn(desk.db, id)?.reminded_at).not.toBeNull();
  expect(
    desk.db
      .query<{ consumed_at: string | null }, [string]>(
        "select consumed_at from event where event_id = ?"
      )
      .get(ownEvent)?.consumed_at
  ).toBeNull();
});

// Regression: "new since your last turn" went by a step's instant, so a step learned late about an earlier hour was
// never shown, and a failed turn moved the cut.
test("a wake lists the matter's steps the assignment was never shown: one learned late shows; a failed turn shows them again", async () => {
  const { desk, end, fake, id, onA, own } = await twoAssignments();
  // Its own assignment waits beyond the test.
  writeWait(
    desk.db,
    own().id,
    { events: [], reason: "r", until: ahead(7 * DAY) },
    false
  );
  const views = (steps: string[]) => [
    matterView("mat_a", steps, "2026-11-01T08:00:00.000Z"),
  ];
  const wakeOnA = async (steps: string[]) => {
    advance(2 * HOUR);
    writeWait(
      desk.db,
      onA().id,
      { events: [], reason: "r", until: ahead(-MIN) },
      false
    );
    await withMatters(views(steps), () => wakeDue(desk));
    return fake.said.at(-1)?.message ?? "";
  };
  expect(await wakeOnA(["obs_a1", "obs_a2"])).toContain("obs_a2 (to_do)");
  await end(id, true);
  // Failed: handed again.
  expect(await wakeOnA(["obs_a1", "obs_a2"])).toContain("obs_a2 (to_do)");
  await setWait(desk, onA(), { events: [], reason: "r", until: ahead(HOUR) });
  await end(id);
  const after = await wakeOnA(["obs_a1", "obs_a2", "obs_a3"]);
  expect(after).not.toContain("obs_a2 (to_do)");
  // A step Life learned since, about an hour before every turn, is new to it.
  expect(after).toContain("obs_a3 (to_do)");
});

/** Wakes assignment `s` on its deadline, the book holding `views`, its agent's own waiting beyond: the wake's text. */
async function deadlineWake(
  t: Awaited<ReturnType<typeof twoAssignments>>,
  views: unknown[]
) {
  advance(2 * HOUR);
  writeWait(
    t.desk.db,
    t.own().id,
    { events: [], reason: "r", until: ahead(7 * DAY) },
    false
  );
  writeWait(
    t.desk.db,
    t.onA().id,
    { events: [], reason: "r", until: ahead(-MIN) },
    false
  );
  await withMatters(views, () => wakeDue(t.desk));
  return t.fake.said.at(-1)?.message ?? "";
}

// Regression: a resumed wake showed 8 steps and counted every step of the matter as shown.
test("a resumed wake shows the newest 8 of 12 new steps; the other 4 are listed next time", async () => {
  const t = await twoAssignments();
  const refs = Array.from({ length: 12 }, (_, i) => `obs_a${i + 1}`);
  const first = await deadlineWake(t, [matterView("mat_a", refs)]);
  expect(first).toContain("obs_a12 (to_do)");
  expect(first).toContain("obs_a5 (to_do)");
  expect(first).not.toContain("obs_a4 (to_do)");
  expect(first).toContain("(and 4 older, listed next time");
  await setWait(t.desk, t.onA(), {
    events: [],
    reason: "r",
    until: ahead(HOUR),
  });
  await t.end(t.id);
  const next = await deadlineWake(t, [matterView("mat_a", refs)]);
  for (const ref of ["obs_a1", "obs_a4"]) {
    expect(next).toContain(`${ref} (to_do)`);
  }
  expect(next).not.toContain("obs_a5 (to_do)");
});

// Regression: a turn ending after his re-point put back what it was shown of the old subject.
test("a turn ending after a re-point keeps nothing of the old subject: its anchors and what it was shown are the new one's", async () => {
  const t = await twoAssignments();
  await deadlineWake(t, MATTERS);
  writeSubject(t.desk, t.id, t.onA().id, { steps: ["obs_b1"] });
  await setWait(t.desk, t.onA(), {
    events: [],
    reason: "r",
    until: ahead(HOUR),
  });
  await t.end(t.id);
  expect(anchorsOf(t.desk.db, t.onA().id)).toEqual(["obs_b1"]);
  expect([...handedSteps(t.desk.db, t.onA().id)]).toEqual([]);
  expect(await deadlineWake(t, MATTERS)).toContain("obs_b1 (to_do)");
});

// Regression: the card was written before the desk wrote whose it was, so a failed write left it to its agent's current
// assignment. Its owner is written first: when that fails, no card is written.
test("a card whose owner cannot be written is never written", async () => {
  const { desk, id, onA } = await twoAssignments();
  desk.db.run(
    "create trigger test_no_card before insert on card begin select raise(abort, 'test: no write'); end"
  );
  await withMatters(MATTERS, async () => {
    await expect(askDecision(desk, onA(), yesNo())).rejects.toThrow(
      "test: no write"
    );
  });
  expect(decisionsNow().filter((d) => d.agent === id)).toEqual([]);
});

// Regression (21 Nov 2026): a card on a step its agent's other assignment holds was refused; it is filed under that one.
test("a card on a step another assignment of its agent is anchored on is filed under that assignment", async () => {
  const { desk, id, onA, own } = await twoAssignments();
  await withMatters(MATTERS, async () => {
    const { id: card } = await askDecision(desk, own(), yesNo("obs_a1"));
    expect(assignmentOfCard(desk.db, { agent: id, id: card })).toBe(onA().id);
    expect(pendingCardOf(desk.db, own())).toBeUndefined();
    await withdrawOpenCards(desk.db, onA(), "test over");
  });
});

// Regression: a fresh turn read its matter twice, once for what it was shown and once for its packet.
test("a fresh turn counts as shown exactly the steps its packet held, though the matter grew between reads", async () => {
  const t = setup();
  const matters = await import("../memory/matters");
  let reads = 0;
  const book = spyOn(matters, "readMatterBook").mockImplementation(() => {
    reads += 1;
    const refs = Array.from({ length: reads }, (_, i) => `obs_f${i + 1}`);
    return Promise.resolve([matterView("mat_f", refs)] as never);
  });
  try {
    const id = await started(t.desk, "obs_f1");
    const packet = t.fake.said.at(-1)?.message ?? "";
    await setWait(t.desk, on(t.desk, id), {
      events: [],
      reason: "r",
      until: ahead(HOUR),
    });
    await t.end(id);
    expect([...handedSteps(t.desk.db, asgOf(t.desk, id))].sort()).toEqual(
      [...new Set(packet.match(/obs_f\d+/g))].sort()
    );
  } finally {
    book.mockRestore();
  }
});

// Regression: WAL with synchronous normal can lose a commit on a crash of the Mac, so a card's owner row written before
// the card could vanish while the card stays.
test("the desk's store syncs every commit to disk", () => {
  const db = openDesk(
    join(mkdtempSync(join(tmpdir(), "life-sync-")), "d.sqlite")
  );
  expect(db.query("pragma synchronous").get()).toEqual({ synchronous: 2 });
  db.close();
});

// Regression: the subject's anchor was written after the card, so a failed write left a card its sibling could take.
// Owner and anchor are now written together before the card: when either fails, nothing is.
test("a card whose subject's anchor cannot be written is never written, and the step stays free", async () => {
  const { desk, id, onA, own } = await twoAssignments();
  desk.db.run(
    "create trigger test_no_anchor before insert on anchor begin select raise(abort, 'test: no anchor'); end"
  );
  await withMatters(MATTERS, async () => {
    await expect(askDecision(desk, onA(), yesNo("obs_a2"))).rejects.toThrow(
      "test: no anchor"
    );
    expect(decisionsNow().filter((d) => d.agent === id)).toEqual([]);
    expect(desk.db.query("select * from card").all()).toEqual([]);
    desk.db.run("drop trigger test_no_anchor");
    const { id: card } = await askDecision(desk, onA(), yesNo("obs_a2"));
    expect(assignmentOfCard(desk.db, { agent: id, id: card })).toBe(onA().id);
    expect(anchorsOf(desk.db, onA().id)).toContain("obs_a2");
    // Its own assignment's ask on that step is filed under the assignment holding it, which already asks.
    await expect(askDecision(desk, own(), yesNo("obs_a2"))).rejects.toThrow(
      "already asks"
    );
  });
});

// Regression (life#764): a card whose write failed took back its owner row and anchor later, after an await, so another
// ask's anchor on the same step could go with it, and the desk stopping between its commit and the card left an anchor
// with no card. Owner, anchor and card are now one transaction: a failed write takes back only its own rows, at once.
test("a card whose write fails leaves neither its owner nor its anchor, and the next ask on that step holds it", async () => {
  const { desk, id, onA, own } = await twoAssignments();
  const files = await import("../core/files");
  const write = spyOn(files, "appendJsonl").mockImplementationOnce(() => {
    throw new Error("test: disk full");
  });
  try {
    await withMatters(MATTERS, async () => {
      await expect(askDecision(desk, onA(), yesNo("obs_a2"))).rejects.toThrow(
        "test: disk full"
      );
      expect(desk.db.query("select * from card").all()).toEqual([]);
      expect(anchorsOf(desk.db, onA().id)).not.toContain("obs_a2");
      const { id: card } = await askDecision(desk, onA(), yesNo("obs_a2"));
      expect(assignmentOfCard(desk.db, { agent: id, id: card })).toBe(onA().id);
      expect(anchorsOf(desk.db, onA().id)).toContain("obs_a2");
      // Its own assignment's ask on that step is filed under A, which holds it and already asks.
      await expect(askDecision(desk, own(), yesNo("obs_a2"))).rejects.toThrow(
        "already asks"
      );
    });
  } finally {
    write.mockRestore();
  }
});

// Regression: a closed assignment kept its anchors, so it refused its agent's other assignment a step it can never ask on.
test("a step goes to its sibling assignment while that one is open, and is free once it closes", async () => {
  const { desk, id, onA, own } = await twoAssignments();
  // The Personal agent takes a matter under no project: once A closes, its own assignment.
  desk.db.run("update agent set role = 'personal' where id = ?", [id]);
  await withMatters(MATTERS, async () => {
    const { id: first } = await askDecision(desk, own(), yesNo("obs_a1"));
    expect(assignmentOfCard(desk.db, { agent: id, id: first })).toBe(onA().id);
    // Its line names the assignment it is filed under, not the one that asked.
    expect(decisionsNow().find((d) => d.id === first)?.assignment).toBe(
      onA().id
    );
    await closeAssignment(desk, onA().id, "test: its matter is done");
    const { id: card } = await askDecision(desk, own(), yesNo("obs_a1"));
    expect(pendingCardOf(desk.db, own())?.id).toBe(card);
  });
});

// Regression: one open card per assignment was checked before the ask's reads, so two asks at once both got a card.
test("two asks at once on one assignment give it exactly one card", async () => {
  const { desk, id, onA } = await twoAssignments();
  await withMatters(MATTERS, async () => {
    const asks = await Promise.allSettled([
      askDecision(desk, onA(), yesNo()),
      askDecision(desk, onA(), yesNo()),
    ]);
    expect(asks.map((a) => a.status).sort()).toEqual(["fulfilled", "rejected"]);
  });
  expect(decisionsNow().filter((d) => d.agent === id)).toHaveLength(1);
  expect(desk.db.query("select * from card").all()).toHaveLength(1);
});
