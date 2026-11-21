import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, DAY, HOUR, iso, MIN } from "../core/clock";
import { take } from "../core/lock";
import { flagsOf } from "../host/agents-now";
import {
  agentOf,
  currentAssignmentOf,
  heldByAgents,
  holderOf,
  openTurn,
} from "../host/desk-read";
import { DECISION_ANSWERED, DECISION_LAPSED } from "../host/events";
import {
  answerDecision,
  decisionsNow,
  requestDecision,
} from "../memory/decisions";
import { isHeldOf } from "../memory/held-matters";
import { LOCK } from "../memory/memory-lock";
import { finish, register, setWait, writeNotes } from "./agent-actions";
import { BEGIN_WITHIN_MS, EVENTS_SETTLE, nextWakeOf } from "./agent-wait";
import {
  pollAnswers,
  pollMessages,
  readPeopleOnce,
  tick,
  wakeDue,
} from "./desk-clock";
import { type Desk, openDesk } from "./desk-store";
import { ANA, advance, ahead, asgOf, on, setup, started } from "./test-desk";
import { endLostTurns } from "./turn-ends";

/** Whether the hold rule holds a matter of one step, `step`, whose newest step is at `at` (the start of time by default). */
const holds = (desk: Desk, step: string, at = "") =>
  Boolean(isHeldOf(heldByAgents(desk.db))({ steps: [{ at, ref: step }] }));

// The wait contract's cases (the desk spec, section 6, W1 to W20): a fake runtime, the clock faked, made-up agents and
// chats. The test plays each agent: its door calls (`setWait`, `finish`) and its turn's end (`turnEnded`).

afterEach(() => {
  setSystemTime();
});

test("W1: the store refuses an open assignment with no deadline", () => {
  const { desk } = setup();
  expect(() =>
    desk.db.run(
      "insert into assignment (id, agent_id, opened_at, opened_by, notes_path) values ('asg_x', 'agt_x', ?, 'owner', '/x')",
      [clock().toISOString()]
    )
  ).toThrow();
});

test("W2: a wait under 5 minutes or over 7 days is refused, and the old wait stands", async () => {
  const { desk, waiting } = setup();
  const id = await waiting();
  const before = currentAssignmentOf(desk.db, id)?.wait_until;
  const refused = await Promise.all(
    [ahead(2 * MIN), ahead(8 * DAY)].map((until) =>
      setWait(desk, on(desk, id), { events: [], reason: "r", until })
    )
  );
  for (const r of refused) {
    expect(r).toHaveProperty("error");
  }
  // A filter on someone Life doesn't know would never match: refused, as the connector's poll refuses it.
  expect(
    await setWait(desk, on(desk, id), {
      events: [{ from_me: false, person: "Nobody Madeup" }],
      reason: "r",
      until: ahead(HOUR),
    })
  ).toEqual({ error: "No one goes by Nobody Madeup" });
  // A part of a name resolves no one: the refusal says who it could be (her whole name resolves: events.test.ts).
  expect(
    await setWait(desk, on(desk, id), {
      events: [{ from_me: false, person: "Ana" }],
      reason: "r",
      until: ahead(HOUR),
    })
  ).toEqual({ error: "No one goes by Ana; near it: Test Ana (test-ana)" });
  expect(currentAssignmentOf(desk.db, id)?.wait_until).toBe(before);
});

test("W3: after set_wait, no turn before the deadline, one right after", async () => {
  const { desk, turns, waiting } = setup();
  const id = await waiting(HOUR);
  expect(openTurn(desk.db, id)).toBeNull();
  advance(HOUR - MIN);
  await wakeDue(desk);
  expect(turns(id)).toHaveLength(1);
  advance(MIN + 5000);
  await wakeDue(desk);
  expect(turns(id).at(-1)).toEqual({ cause: "deadline", outcome: null });
});

test("W4: a turn ending with no set_wait is reminded once; set then, no default wait", async () => {
  const { desk, end, fake, turns } = setup();
  const id = register(desk, { brief: "b", folder: "/", runtime: "fake" });
  await wakeDue(desk);
  await end(id);
  expect(fake.said.at(-1)?.message).toContain("set_wait");
  await setWait(desk, on(desk, id), {
    events: [],
    reason: "r",
    until: ahead(HOUR),
  });
  await end(id);
  expect(turns(id)).toEqual([{ cause: "deadline", outcome: "waited" }]);
  expect(currentAssignmentOf(desk.db, id)?.wait_is_default).toBe(0);
});

test("W5: the reminded turn ending with nothing gets the default wait: old filters, 24 h, flagged", async () => {
  const { desk, end, turns, waiting } = setup();
  const id = await waiting();
  advance(HOUR);
  await wakeDue(desk);
  await end(id);
  await end(id);
  const a = currentAssignmentOf(desk.db, id);
  expect(turns(id).at(-1)?.outcome).toBe("default_wait");
  expect(a?.wait_until).toBe(ahead(DAY));
  expect(JSON.parse(a?.wait_events ?? "")).toEqual([ANA]);
  expect(a && flagsOf(a, null, 0, clock().getTime()).defaultWait).toBe(true);
});

test("W6: a failure mid-turn leaves its events queued and retries at 5 minutes", async () => {
  const { desk, end, eventRow, queue, turns, waiting } = setup();
  const id = await waiting();
  queue(id, "e1");
  advance(10 * MIN);
  await wakeDue(desk);
  await end(id, true);
  expect(turns(id).at(-1)?.outcome).toBe("failed");
  expect(eventRow(id, "e1")?.consumed_at).toBeNull();
  advance(4 * MIN);
  await wakeDue(desk);
  expect(turns(id)).toHaveLength(2);
  advance(MIN);
  await wakeDue(desk);
  expect(turns(id).at(-1)).toEqual({ cause: "retry", outcome: null });
});

test("W7: a matching message wakes a waiting agent once its last turn is 10 minutes old; others don't", async () => {
  const { desk, turns, waiting, write } = setup();
  const id = await waiting(DAY);
  await pollMessages(desk, readPeopleOnce());
  write("Test Bruno");
  advance(3 * MIN);
  write();
  await pollMessages(desk, readPeopleOnce());
  await wakeDue(desk);
  expect(turns(id)).toHaveLength(1);
  advance(7 * MIN + 30_000);
  await pollMessages(desk, readPeopleOnce());
  await wakeDue(desk);
  expect(turns(id).at(-1)).toEqual({ cause: "event", outcome: null });
  expect(desk.db.query("select event_id from event").all()).toEqual([
    { event_id: "whatsapp:m2" },
  ]);
});

test("W8: an event during a turn waits in the queue; a turn starts after the first ends", async () => {
  const { desk, end, eventRow, turns, waiting, write } = setup();
  const id = await waiting();
  await pollMessages(desk, readPeopleOnce());
  advance(HOUR);
  await wakeDue(desk);
  const m = write();
  await pollMessages(desk, readPeopleOnce());
  await setWait(desk, on(desk, id), {
    events: [ANA],
    reason: "r",
    until: ahead(DAY),
  });
  await end(id);
  expect(eventRow(id, m)).toEqual({
    consumed_at: null,
    dropped_at: null,
    handed: 0,
  });
  advance(10 * MIN);
  await wakeDue(desk);
  expect(turns(id).at(-1)).toEqual({ cause: "event", outcome: null });
  expect(eventRow(id, m)?.handed).toBe(1);
});

test("W9: an event read twice is one row, handed once", async () => {
  const { desk, eventRow, turns, waiting, write } = setup();
  const id = await waiting();
  await pollMessages(desk, readPeopleOnce());
  const start = desk.db.query("select value from cursor").get();
  const m = write();
  await pollMessages(desk, readPeopleOnce());
  desk.db.run("update cursor set value = ?", [
    (start as { value: string }).value,
  ]);
  await pollMessages(desk, readPeopleOnce());
  expect(desk.db.query("select count(*) as n from event").get()).toEqual({
    n: 1,
  });
  advance(10 * MIN);
  await wakeDue(desk);
  expect(turns(id)).toHaveLength(2);
  expect(eventRow(id, m)?.handed).toBe(1);
});

test("W10: killed before the transaction commits, the next poll reads the same events", async () => {
  const { desk, path, waiting, write } = setup();
  await waiting();
  await pollMessages(desk, readPeopleOnce());
  const cursor = desk.db.query("select value from cursor").get();
  const m = write();
  desk.db.run("drop table cursor");
  await expect(pollMessages(desk, readPeopleOnce())).rejects.toThrow();
  expect(desk.db.query("select count(*) as n from event").get()).toEqual({
    n: 0,
  });
  const again = { ...desk, db: openDesk(path) };
  again.db.run(
    "insert into cursor (name, value) values ('message.received', ?)",
    [(cursor as { value: string }).value]
  );
  await pollMessages(again, readPeopleOnce());
  expect(again.db.query("select event_id from event").all()).toEqual([
    { event_id: m },
  ]);
});

test("W12: a 9-hour jump over 5 deadlines runs all 5, 3 at a time, oldest first", async () => {
  const { desk, end, waiting } = setup();
  const ids: string[] = [];
  for (const hours of [5, 2, 4, 1, 3]) {
    // biome-ignore lint/performance/noAwaitInLoops: agents registered in order
    ids.push(await waiting(hours * HOUR));
  }
  advance(9 * HOUR);
  const running = () => ids.filter((id) => openTurn(desk.db, id));
  await wakeDue(desk);
  expect(running()).toEqual(ids.filter((_, i) => [1, 3, 4].includes(i)));
  for (const id of running()) {
    // biome-ignore lint/performance/noAwaitInLoops: one turn's end at a time
    await setWait(desk, on(desk, id), {
      events: [],
      reason: "r",
      until: ahead(DAY),
    });
    await end(id);
  }
  await wakeDue(desk);
  expect(running()).toEqual(ids.filter((_, i) => [0, 2].includes(i)));
});

test("W13: on restart, a running turn its runtime doesn't know failed, and is retried", async () => {
  const { desk, fake, path, turns, waiting } = setup();
  const id = await waiting();
  advance(HOUR);
  await wakeDue(desk);
  fake.sessions.clear();
  // The helper started again: its own store handle, no run watched.
  const again: Desk = { ...desk, db: openDesk(path) };
  await endLostTurns(again);
  expect(turns(id).at(-1)?.outcome).toBe("failed");
  advance(5 * MIN);
  await wakeDue(again);
  expect(turns(id).at(-1)).toEqual({ cause: "retry", outcome: null });
  expect(fake.sessions.size).toBe(1);
});

test("W14: his answer starts a turn at once, ahead of older deadlines, with no 10-minute gap; a lapse too", async () => {
  const { desk, queue, turns, waiting } = setup();
  const others = [await waiting(), await waiting(), await waiting()];
  const id = await waiting(DAY);
  const lapsed = await waiting(DAY);
  advance(2 * HOUR);
  queue(id, "dec_1.answered", DECISION_ANSWERED);
  queue(lapsed, "dec_2.lapsed", DECISION_LAPSED);
  await wakeDue(desk);
  expect(turns(id).at(-1)).toEqual({ cause: "answer", outcome: null });
  expect(turns(lapsed).at(-1)).toEqual({ cause: "answer", outcome: null });
  expect(others.filter((o) => openTurn(desk.db, o))).toHaveLength(1);
});

test("his answer, read from his decisions, is queued for the agent that asked it and wakes it", async () => {
  const { desk, turns, waiting } = setup();
  const id = await waiting(DAY);
  const other = await waiting(DAY);
  pollAnswers(desk);
  const { id: dec } = await requestDecision("desk", {
    agent: id,
    context: "A made-up reason to ask.",
    deadline: ahead(DAY),
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    question: "Test: book the made-up table?",
    title: "a test",
  });
  advance(1000);
  await answerDecision(dec, ["yes"]);
  advance(1000);
  pollAnswers(desk);
  pollAnswers(desk);
  await wakeDue(desk);
  expect(turns(id).at(-1)).toEqual({ cause: "answer", outcome: null });
  expect(turns(other)).toHaveLength(1);
  expect(
    desk.db
      .query("select event_id, name from event where assignment_id = ?")
      .all(asgOf(desk, id))
  ).toEqual([{ event_id: `${dec}.answered`, name: DECISION_ANSWERED }]);
  // Its deadline passing unanswered is a lapse, queued the same way.
  const { id: lapsing } = await requestDecision("desk", {
    agent: other,
    context: "A made-up reason to ask.",
    deadline: ahead(2 * HOUR),
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    question: "Test: order the made-up flour?",
    title: "a test",
  });
  advance(2 * HOUR + 1000);
  pollAnswers(desk);
  expect(
    desk.db
      .query("select event_id, name from event where assignment_id = ?")
      .all(asgOf(desk, other))
  ).toEqual([{ event_id: `${lapsing}.lapsed`, name: DECISION_LAPSED }]);
});

test("W15: while he runs the session himself, the agent waits; its old wait still fires after", async () => {
  const { desk, fake, turns, waiting } = setup();
  const id = await waiting(HOUR);
  const s = fake.sessions.get(agentOf(desk.db, id)?.session ?? "");
  if (s) {
    s.running = true;
  }
  advance(HOUR + MIN);
  await wakeDue(desk);
  expect(turns(id)).toHaveLength(1);
  if (s) {
    s.running = false;
  }
  await wakeDue(desk);
  expect(turns(id).at(-1)).toEqual({ cause: "deadline", outcome: null });
});

test("a run's end ends its turn, once: the lost-turn check leaves a watched run alone", async () => {
  const { desk, fake, turns, waiting } = setup();
  const id = await waiting();
  advance(HOUR);
  await wakeDue(desk);
  const ref = agentOf(desk.db, id)?.session ?? "";
  await setWait(desk, on(desk, id), {
    events: [],
    reason: "r",
    until: ahead(HOUR),
  });
  const s = fake.sessions.get(ref);
  if (s) {
    s.running = false;
  }
  await endLostTurns(desk);
  expect(openTurn(desk.db, id)).not.toBeNull();
  fake.exit(ref);
  await Bun.sleep(0);
  expect(turns(id).at(-1)).toEqual({ cause: "deadline", outcome: "waited" });
});

// Regression (his ruling of 20 Nov 2026): a session is resumed however much it grew; its runtime compacts it.
test("W16a: a wake into a session past the old 120,000-token limit resumes it", async () => {
  const { desk, waiting } = setup();
  const id = await waiting();
  const old = agentOf(desk.db, id);
  desk.db.run("update session set context_at_first_call = 1000 where ref = ?", [
    old?.session ?? "",
  ]);
  desk.db.run("update turn set context_used = 500000 where agent_id = ?", [id]);
  advance(HOUR);
  await wakeDue(desk);
  expect(agentOf(desk.db, id)?.session).toBe(old?.session);
});

test("W16: a wake into a session that is gone starts a fresh one from the packet; the old link stays", async () => {
  const { desk, fake, waiting } = setup();
  const id = await waiting();
  const old = agentOf(desk.db, id);
  expect(fake.said.at(-1)?.title).toBe("Agent: Test brief: follow up with Ana");
  fake.sessions.delete(old?.session ?? "");
  writeNotes(desk, on(desk, id), "Test notes: Ana may answer Friday");
  desk.db.run("update agent set name = 'Ana' where id = ?", [id]);
  advance(HOUR);
  await wakeDue(desk);
  const now = agentOf(desk.db, id);
  expect(now?.session).not.toBe(old?.session);
  expect(fake.said.at(-1)?.message).toContain("Test brief");
  expect(fake.said.at(-1)?.message).toContain("Ana may answer Friday");
  // A session's title is "Agent: " and the name he gave it, else its brief's first line (the first session's, above).
  expect(fake.said.at(-1)?.title).toBe("Agent: Ana");
  expect(
    desk.db
      .query(
        "select link, why_ended from session where agent_id = ? order by rowid"
      )
      .all(id)
  ).toEqual([
    { link: old?.link, why_ended: "fresh" },
    { link: now?.link, why_ended: null },
  ]);
});

test("W17: a turn silent for 61 minutes is flagged, never killed", async () => {
  const { desk, fake, waiting } = setup();
  const id = await waiting();
  advance(HOUR);
  await wakeDue(desk);
  advance(61 * MIN);
  await wakeDue(desk);
  const a = currentAssignmentOf(desk.db, id);
  const open = openTurn(desk.db, id);
  expect(a && flagsOf(a, open, 0, clock().getTime()).silent).toBe(true);
  expect(open).not.toBeNull();
  expect(fake.sessions.get(agentOf(desk.db, id)?.session ?? "")?.running).toBe(
    true
  );
});

test("W18: wakes run while the night holds the memory lock", async () => {
  const { desk, turns, waiting } = setup();
  const id = await waiting();
  expect(take(LOCK, "nightly")).toBe(true);
  try {
    advance(HOUR);
    await wakeDue(desk);
    expect(turns(id).at(-1)).toEqual({ cause: "deadline", outcome: null });
  } finally {
    rmSync(LOCK, { force: true });
  }
});

test("W20: finish ends the agent and withdraws its open decision", async () => {
  const { desk, end, fake, turns, waiting } = setup();
  const id = await waiting();
  const asked = await requestDecision("desk", {
    agent: id,
    context: "A made-up reason to ask.",
    deadline: ahead(DAY),
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    question: "Test: send the made-up reply to Ana?",
    title: "a test",
  });
  fake.sessions.delete(agentOf(desk.db, id)?.session ?? "");
  advance(HOUR);
  await wakeDue(desk);
  expect(fake.said.at(-1)?.message).toContain(asked.id);
  await finish(desk, on(desk, id), "done");
  await end(id);
  expect(agentOf(desk.db, id)?.status).toBe("ended");
  expect(decisionsNow().find((d) => d.id === asked.id)?.state).toBe(
    "withdrawn"
  );
  expect(turns(id).at(-1)?.outcome).toBe("finished");
  advance(DAY);
  await wakeDue(desk);
  expect(turns(id)).toHaveLength(2);
});

test("a turn that ends before its runtime's send returns is closed, and the next deadline still fires", async () => {
  const { desk, end, fake, turns, waiting } = setup();
  const id = await waiting();
  fake.duringSend = async () => {
    await setWait(desk, on(desk, id), {
      events: [],
      reason: "r",
      until: ahead(HOUR),
    });
    await end(id);
  };
  advance(HOUR);
  await wakeDue(desk);
  fake.duringSend = undefined;
  expect(openTurn(desk.db, id)).toBeNull();
  expect(turns(id).at(-1)).toEqual({ cause: "deadline", outcome: "waited" });
  advance(HOUR);
  await wakeDue(desk);
  expect(turns(id).at(-1)).toEqual({ cause: "deadline", outcome: null });
});

test("agents whose sessions run turns of his take no place among a tick's 3 starts", async () => {
  const { desk, fake, waiting } = setup();
  const busy = [await waiting(HOUR), await waiting(HOUR), await waiting(HOUR)];
  const id = await waiting(2 * HOUR);
  for (const b of busy) {
    const s = fake.sessions.get(agentOf(desk.db, b)?.session ?? "");
    if (s) {
      s.running = true;
    }
  }
  advance(3 * HOUR);
  await wakeDue(desk);
  expect(openTurn(desk.db, id)).not.toBeNull();
});

test("with `desk` unset, the desk helper runs nothing: no lock, no store", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-desk-off-"));
  try {
    const run = Bun.spawnSync(
      ["bun", join(import.meta.dir, "life-entry.ts"), "desk"],
      {
        env: {
          ...process.env,
          LIFE_OWNER_DATA_DIR: dir,
          LIFE_STATE_DIR: dir,
          NODE_ENV: "",
        },
      }
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain("Desk is off");
    expect(existsSync(join(dir, "desk"))).toBe(false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// A first turn that never begins: the agent is ended, not retried (his yes of 18 Nov 2026).

test("a run reporting begun writes the turn's begun_at once", async () => {
  const { desk, fake } = setup();
  fake.holdBegun();
  const id = await started(desk, "obs_00000000b001");
  const ref = agentOf(desk.db, id)?.session ?? "";
  expect(openTurn(desk.db, id)?.begun_at).toBeNull();
  fake.begin(ref);
  await Bun.sleep(0);
  expect(openTurn(desk.db, id)?.begun_at).toBe(clock().toISOString());
});

test("a runtime that cannot start ends a new agent, not started, and frees its matter", async () => {
  const { desk, fake, turns } = setup();
  fake.isFailing = true;
  const id = await started(desk, "obs_00000000b002");
  expect(agentOf(desk.db, id)?.status).toBe("ended");
  expect(currentAssignmentOf(desk.db, id)).toMatchObject({
    outcome: null,
    why_not_started: "cannot start",
  });
  expect(holderOf(desk.db, ["obs_00000000b002"])).toBeNull();
  // Not held for the inbox either: the new matter card comes back for another Start.
  expect(holds(desk, "obs_00000000b002")).toBe(false);
  expect(turns(id)).toEqual([{ cause: "deadline", outcome: "failed" }]);
});

test("a first turn whose run ends before it began ends its agent; one that had begun is retried", async () => {
  const { desk, fake, turns } = setup();
  fake.holdBegun();
  const lost = await started(desk, "obs_00000000b003");
  fake.exit(agentOf(desk.db, lost)?.session ?? "", false);
  await Bun.sleep(5);
  expect(agentOf(desk.db, lost)?.status).toBe("ended");
  expect(currentAssignmentOf(desk.db, lost)?.why_not_started).toBe(
    "its first turn ended before it began"
  );

  const begun = await started(desk, "obs_00000000b004");
  const ref = agentOf(desk.db, begun)?.session ?? "";
  fake.begin(ref);
  await Bun.sleep(0);
  fake.exit(ref, false);
  await Bun.sleep(5);
  expect(agentOf(desk.db, begun)?.status).toBe("active");
  expect(turns(begun)).toEqual([{ cause: "deadline", outcome: "failed" }]);
});

test("a restart never ends an agent whose first turn had begun, and ends one whose first turn had not", async () => {
  const { desk, fake, path } = setup();
  fake.holdBegun();
  const never = await started(desk, "obs_00000000b005");
  const did = await started(desk, "obs_00000000b006");
  fake.begin(agentOf(desk.db, did)?.session ?? "");
  await Bun.sleep(0);
  fake.sessions.clear();
  const again: Desk = { ...desk, db: openDesk(path) };
  await endLostTurns(again);
  expect(agentOf(again.db, never)?.status).toBe("ended");
  expect(agentOf(again.db, did)?.status).toBe("active");
});

test("a first turn that began in the instant its run failed is retried, not ended as not started", async () => {
  const { desk, fake, turns } = setup();
  fake.holdBegun();
  const id = await started(desk, "obs_00000000b007");
  const ref = agentOf(desk.db, id)?.session ?? "";
  // It exits failed and `begun` settles right after `ended`.
  fake.exit(ref, false, { isBegunLate: true });
  await Bun.sleep(5);
  expect(agentOf(desk.db, id)?.status).toBe("active");
  expect(turns(id)).toEqual([{ cause: "deadline", outcome: "failed" }]);
});

test("a runtime that can't say a lost turn's state leaves it alone this poll: never marked begun, never ended", async () => {
  const { desk, fake, path } = setup();
  fake.holdBegun();
  const id = await started(desk, "obs_00000000b009");
  const again: Desk = {
    ...desk,
    db: openDesk(path),
    runtimes: {
      fake: {
        ...fake.runtime,
        state: () => Promise.reject(new Error("pgrep: no answer")),
      },
    },
  };
  await endLostTurns(again);
  expect(openTurn(again.db, id)).toMatchObject({
    begun_at: null,
    ended_at: null,
  });
});

test("a first turn not begun within its runtime's limit ends its agent not started, its run stopped and its matter freed; a later one is retried", async () => {
  const { desk, fake, turns, waiting } = setup();
  const later = await waiting();
  fake.holdBegun();
  const id = await started(desk, "obs_00000000b010");
  const ref = agentOf(desk.db, id)?.session ?? "";
  advance(BEGIN_WITHIN_MS - MIN);
  await tick(desk, false);
  expect(agentOf(desk.db, id)?.status).toBe("active");
  advance(2 * MIN);
  await tick(desk, false);
  expect(agentOf(desk.db, id)?.status).toBe("ended");
  expect(currentAssignmentOf(desk.db, id)?.why_not_started).toBe(
    "it did not begin within 5 minutes"
  );
  expect(fake.stopped).toEqual([ref]);
  expect(holderOf(desk.db, ["obs_00000000b010"])).toBeNull();
  expect(holds(desk, "obs_00000000b010")).toBe(false);
  // An agent that had begun before: its turn that never begins fails and is retried; it stays active.
  advance(HOUR);
  await wakeDue(desk);
  advance(BEGIN_WITHIN_MS + MIN);
  await tick(desk, false);
  expect(agentOf(desk.db, later)?.status).toBe("active");
  expect(turns(later).at(-1)).toEqual({ cause: "deadline", outcome: "failed" });
});

test("an agent that finished in its own words, even 'not started: …', keeps its matter: only the desk's field frees it", async () => {
  const { desk } = setup();
  const id = await started(desk, "obs_00000000b011");
  await finish(desk, on(desk, id), "not started: the client never replied");
  expect(currentAssignmentOf(desk.db, id)?.why_not_started).toBeNull();
  expect(holds(desk, "obs_00000000b011")).toBe(true);
});

test("an agent that finished holds its step until its matter has a newer step, however long ago it ended", async () => {
  const { desk } = setup();
  const id = await started(desk, "obs_00000000b012");
  await finish(desk, on(desk, id), "done");
  advance(8 * DAY);
  expect(holds(desk, "obs_00000000b012")).toBe(true);
  expect(holds(desk, "obs_00000000b012", clock().toISOString())).toBe(false);
});

test("an agent that finished while another's wake was launching gets no turn: each is read again as its turn is written", async () => {
  const { desk, fake, turns, waiting } = setup();
  const first = await waiting();
  const second = await waiting();
  advance(HOUR + MIN);
  let isFinished = false;
  fake.duringSend = async () => {
    if (!isFinished) {
      isFinished = true;
      await finish(desk, on(desk, second), "done in his own session");
    }
  };
  await wakeDue(desk);
  expect(turns(first)).toHaveLength(2);
  expect(turns(second)).toHaveLength(1);
});

test("an agent he stopped mid-turn gets no reminder when that turn ends without set_wait", async () => {
  const { desk, end, fake, turns, waiting } = setup();
  const id = await waiting();
  advance(HOUR + MIN);
  await wakeDue(desk);
  const said = fake.said.length;
  desk.db.run("update agent set status = 'stopped' where id = ?", [id]);
  await end(id);
  expect(fake.said).toHaveLength(said);
  expect(turns(id).at(-1)?.outcome).toBe("default_wait");
});

test("a run launched whose session write fails is still watched: its turn is not failed, and ends when the run does", async () => {
  const { desk, fake, turns } = setup();
  const run = desk.db.run.bind(desk.db);
  const failing = spyOn(desk.db, "run").mockImplementation(((
    sql: string,
    ...rest: never[]
  ) => {
    if (sql.startsWith("insert into session")) {
      throw new Error("database is locked");
    }
    return run(sql, ...rest);
  }) as never);
  fake.holdBegun();
  const id = await started(desk, "obs_00000000b013");
  failing.mockRestore();
  expect(agentOf(desk.db, id)?.status).toBe("active");
  const [ref] = [...fake.sessions.keys()];
  fake.begin(ref ?? "");
  fake.exit(ref ?? "", true);
  await Bun.sleep(5);
  expect(turns(id)).toEqual([{ cause: "deadline", outcome: "default_wait" }]);
});

test("a lost turn's run records are forgotten when it is ended", async () => {
  const { desk, fake, path, waiting } = setup();
  const id = await waiting();
  advance(HOUR + MIN);
  await wakeDue(desk);
  const ref = agentOf(desk.db, id)?.session ?? "";
  fake.sessions.clear();
  await endLostTurns({ ...desk, db: openDesk(path) });
  expect(fake.stopped).toEqual([ref]);
});

test("a new agent's first turn ranks with his answers, ahead of older deadlines, within a tick's 3 starts", async () => {
  const { desk, turns, waiting } = setup();
  for (let i = 0; i < 3; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: agents made in order
    await waiting();
  }
  advance(2 * HOUR);
  const id = register(desk, {
    brief: "Test brief: a new start",
    folder: tmpdir(),
    runtime: "fake",
  });
  await wakeDue(desk);
  expect(turns(id)).toHaveLength(1);
});

test("an event wakes once its events stop coming for 5 minutes, at most 10 after the first, and 10 after the last turn", () => {
  // A burst of made-up messages: the agent drafts once it is in, not on its first line (withdrawn cards, 21 Nov 2026).
  const t0 = Date.parse("2026-11-20T10:00:00Z");
  const s = { opened_at: iso(t0 - DAY), wait_until: iso(t0 + DAY) };
  const message = (after: number) =>
    ({ name: "message.received", received_at: iso(t0 + after) }) as never;
  const ended = (before: number) =>
    [
      { cause: "event", ended_at: iso(t0 - before), outcome: "waited" },
    ] as never;
  const dueAt = (turns: never[], ...afters: number[]) =>
    nextWakeOf(s, turns, afters.map(message))?.at;
  expect(dueAt([], 0)).toBe(t0 + EVENTS_SETTLE);
  expect(dueAt([], 0, 3 * MIN)).toBe(t0 + 8 * MIN);
  expect(dueAt([], 0, 4 * MIN, 8 * MIN)).toBe(t0 + 10 * MIN);
  expect(dueAt(ended(2 * MIN), 0)).toBe(t0 + 8 * MIN);
});
