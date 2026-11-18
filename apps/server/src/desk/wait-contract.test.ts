import { afterEach, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, DAY, HOUR, iso, MIN } from "../core/clock";
import { take } from "../core/lock";
import {
  agentOf,
  anchoredSteps,
  flagsOf,
  holderOf,
  openTurn,
} from "../host/desk-read";
import type { Messaging } from "../host/events";
import { DECISION_ANSWERED, DECISION_LAPSED } from "../host/events";
import {
  answerDecision,
  decisionsNow,
  requestDecision,
} from "../memory/decisions";
import { LOCK } from "../memory/memory-lock";
import type { SourceEvent } from "../records/source";
import { finish, register, setWait, writeNotes } from "./agent-actions";
import {
  endLostTurns,
  pollAnswers,
  pollMessages,
  turnEnded,
  wakeDue,
} from "./desk-clock";
import { type Desk, openDesk } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";

// The wait contract's cases (the desk spec, section 6, W1 to W20): a fake runtime, the clock faked, made-up agents and
// chats. The test plays each agent: its door calls (`setWait`, `finish`) and its turn's end (`turnEnded`).

const T0 = Date.UTC(2026, 10, 18, 9, 0);
const ANA = { chat: "Test Ana", from_me: false };

afterEach(() => {
  setSystemTime();
});

const advance = (ms: number) => setSystemTime(new Date(clock().getTime() + ms));
const ahead = (ms: number) => iso(clock().getTime() + ms);

/** A chat store whose messages are `list`, row by row, as `incoming` and `read` see it. */
const chatSource = (list: SourceEvent[]) =>
  ({
    incoming: (from: number) => ({
      end: list.length + 1,
      rows: list
        .map((e, i) => ({ at: e.at, id: e.id, row: i + 1 }))
        .filter((r) => r.row >= from),
    }),
    kind: "chat",
    label: "WhatsApp",
    name: "whatsapp",
    read: (since: Date) => list.filter((e) => e.at >= since.toISOString()),
    silentAfter: 0,
  }) as Messaging;

function setup() {
  setSystemTime(new Date(T0));
  const dir = mkdtempSync(join(tmpdir(), "life-desk-"));
  const fake = fakeRuntime();
  const messages: SourceEvent[] = [];
  const path = join(dir, "desk.sqlite");
  const desk: Desk = {
    db: openDesk(path),
    runtimes: { fake: fake.runtime },
    sources: [chatSource(messages)],
  };
  /** A message in a made-up chat, now. */
  const write = (chat = "Test Ana") => {
    const id = `whatsapp:m${messages.length + 1}`;
    messages.push({
      at: clock().toISOString(),
      chat,
      fromMe: false,
      id,
      sender: chat,
      source: "whatsapp",
      text: "hello",
    });
    return id;
  };
  /** The agent's turn ends, as its runtime reports it. */
  const end = async (id: string, failed = false) => {
    const s = fake.sessions.get(agentOf(desk.db, id)?.session ?? "");
    if (s) {
      s.running = false;
    }
    await turnEnded(desk, id, failed);
  };
  /** A registered agent after its first turn: waiting for Ana's messages until `until`. */
  const waiting = async (until = HOUR) => {
    const id = register(desk, {
      brief: "Test brief: follow up with Ana",
      folder: dir,
      runtime: "fake",
    });
    await wakeDue(desk);
    await setWait(desk, id, {
      events: [ANA],
      reason: "Ana's reply",
      until: ahead(until),
    });
    await end(id);
    return id;
  };
  const turns = (id: string) =>
    desk.db
      .query<{ cause: string; outcome: string | null }, [string]>(
        "select cause, outcome from turn where agent_id = ? order by id"
      )
      .all(id);
  const queue = (id: string, eventId: string, name = "message.received") =>
    desk.db.run(
      "insert into event (agent_id, event_id, name, payload, received_at) values (?, ?, ?, '{}', ?)",
      [id, eventId, name, clock().toISOString()]
    );
  const eventRow = (id: string, eventId: string) =>
    desk.db
      .query<
        {
          consumed_at: string | null;
          dropped_at: string | null;
          handed: number;
        },
        [string, string]
      >(
        "select handed, consumed_at, dropped_at from event where agent_id = ? and event_id = ?"
      )
      .get(id, eventId);
  return { desk, dir, end, eventRow, fake, path, queue, turns, waiting, write };
}

test("W1: the store refuses an active agent with no deadline", () => {
  const { desk } = setup();
  expect(() =>
    desk.db.run(
      "insert into agent (id, brief, runtime, folder, status, created_at) values ('agt_x', 'b', 'fake', '/', 'active', ?)",
      [clock().toISOString()]
    )
  ).toThrow();
});

test("W2: a wait under 5 minutes or over 7 days is refused, and the old wait stands", async () => {
  const { desk, waiting } = setup();
  const id = await waiting();
  const before = agentOf(desk.db, id)?.wait_until;
  const refused = await Promise.all(
    [ahead(2 * MIN), ahead(8 * DAY)].map((until) =>
      setWait(desk, id, { events: [], reason: "r", until })
    )
  );
  for (const r of refused) {
    expect(r).toHaveProperty("error");
  }
  // A filter on someone Life doesn't know would never match: refused, as the connector's poll refuses it.
  expect(
    await setWait(desk, id, {
      events: [{ from_me: false, person: "Nobody Madeup" }],
      reason: "r",
      until: ahead(HOUR),
    })
  ).toEqual({ error: "No one goes by Nobody Madeup" });
  expect(agentOf(desk.db, id)?.wait_until).toBe(before);
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
  await setWait(desk, id, { events: [], reason: "r", until: ahead(HOUR) });
  await end(id);
  expect(turns(id)).toEqual([{ cause: "deadline", outcome: "waited" }]);
  expect(agentOf(desk.db, id)?.wait_is_default).toBe(0);
});

test("W5: the reminded turn ending with nothing gets the default wait: old filters, 24 h, flagged", async () => {
  const { desk, end, turns, waiting } = setup();
  const id = await waiting();
  advance(HOUR);
  await wakeDue(desk);
  await end(id);
  await end(id);
  const a = agentOf(desk.db, id);
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
  await pollMessages(desk);
  write("Test Bruno");
  advance(3 * MIN);
  write();
  await pollMessages(desk);
  await wakeDue(desk);
  expect(turns(id)).toHaveLength(1);
  advance(7 * MIN + 30_000);
  await pollMessages(desk);
  await wakeDue(desk);
  expect(turns(id).at(-1)).toEqual({ cause: "event", outcome: null });
  expect(desk.db.query("select event_id from event").all()).toEqual([
    { event_id: "whatsapp:m2" },
  ]);
});

test("W8: an event during a turn waits in the queue; a turn starts after the first ends", async () => {
  const { desk, end, eventRow, turns, waiting, write } = setup();
  const id = await waiting();
  await pollMessages(desk);
  advance(HOUR);
  await wakeDue(desk);
  const m = write();
  await pollMessages(desk);
  await setWait(desk, id, { events: [ANA], reason: "r", until: ahead(DAY) });
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
  await pollMessages(desk);
  const start = desk.db.query("select value from cursor").get();
  const m = write();
  await pollMessages(desk);
  desk.db.run("update cursor set value = ?", [
    (start as { value: string }).value,
  ]);
  await pollMessages(desk);
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
  await pollMessages(desk);
  const cursor = desk.db.query("select value from cursor").get();
  const m = write();
  desk.db.run("drop table cursor");
  await expect(pollMessages(desk)).rejects.toThrow();
  expect(desk.db.query("select count(*) as n from event").get()).toEqual({
    n: 0,
  });
  const again = { ...desk, db: openDesk(path) };
  again.db.run(
    "insert into cursor (name, value) values ('message.received', ?)",
    [(cursor as { value: string }).value]
  );
  await pollMessages(again);
  expect(again.db.query("select event_id from event").all()).toEqual([
    { event_id: m },
  ]);
});

test("W11: an event handed to every failing turn is dropped, flagged, and the default wait stands", async () => {
  const { desk, eventRow, fake, queue, turns, waiting } = setup();
  const id = await waiting();
  queue(id, "e1");
  fake.isFailing = true;
  advance(10 * MIN);
  for (const wait of [0, 5 * MIN, 10 * MIN, 20 * MIN]) {
    advance(wait);
    // biome-ignore lint/performance/noAwaitInLoops: one retry after another
    await wakeDue(desk);
  }
  expect(turns(id).map((t) => t.outcome)).toEqual([
    "waited",
    "failed",
    "failed",
    "failed",
    "failed",
  ]);
  const row = eventRow(id, "e1");
  expect(row?.handed).toBe(4);
  expect(row?.dropped_at).not.toBeNull();
  expect(agentOf(desk.db, id)?.wait_is_default).toBe(1);
  advance(HOUR);
  await wakeDue(desk);
  expect(turns(id)).toHaveLength(5);
  // At the default wait's deadline a new run of failures starts: retried at 5 minutes, not another 24 hours.
  advance(DAY);
  await wakeDue(desk);
  advance(5 * MIN);
  await wakeDue(desk);
  expect(turns(id).slice(-2)).toEqual([
    { cause: "deadline", outcome: "failed" },
    { cause: "retry", outcome: "failed" },
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
    await setWait(desk, id, { events: [], reason: "r", until: ahead(DAY) });
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
    desk.db.query("select event_id, name from event where agent_id = ?").all(id)
  ).toEqual([{ event_id: `${dec}.answered`, name: DECISION_ANSWERED }]);
  // Its deadline passing unanswered is a lapse, queued the same way.
  const { id: lapsing } = await requestDecision("desk", {
    agent: other,
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
      .query("select event_id, name from event where agent_id = ?")
      .all(other)
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
  await setWait(desk, id, { events: [], reason: "r", until: ahead(HOUR) });
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

test("W16: a wake into a session grown by 45,000 tokens starts a fresh one from the packet; the old link stays", async () => {
  const { desk, fake, waiting } = setup();
  const id = await waiting();
  const old = agentOf(desk.db, id);
  const s = fake.sessions.get(old?.session ?? "");
  if (s) {
    s.grownBy = 45_000;
  }
  writeNotes(desk, id, "Test notes: Ana may answer Friday");
  advance(HOUR);
  await wakeDue(desk);
  const now = agentOf(desk.db, id);
  expect(now?.session).not.toBe(old?.session);
  expect(fake.said.at(-1)?.message).toContain("Test brief");
  expect(fake.said.at(-1)?.message).toContain("Ana may answer Friday");
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
  const a = agentOf(desk.db, id);
  const open = openTurn(desk.db, id);
  expect(a && flagsOf(a, open, 0, clock().getTime()).silent).toBe(true);
  expect(open).not.toBeNull();
  expect(fake.sessions.get(a?.session ?? "")?.running).toBe(true);
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
    deadline: ahead(DAY),
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    question: "Test: send the made-up reply to Ana?",
    title: "a test",
  });
  const s = fake.sessions.get(agentOf(desk.db, id)?.session ?? "");
  if (s) {
    s.grownBy = 45_000;
  }
  advance(HOUR);
  await wakeDue(desk);
  expect(fake.said.at(-1)?.message).toContain(asked.id);
  await finish(desk, id, "done");
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
    await setWait(desk, id, { events: [], reason: "r", until: ahead(HOUR) });
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

/** A new agent on a made-up matter, its first turn launched. */
async function started(desk: Desk, step: string) {
  const id = register(desk, {
    brief: "Test brief: watch the repair",
    folder: tmpdir(),
    runtime: "fake",
    steps: [step],
  });
  await wakeDue(desk);
  return id;
}

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
  expect(agentOf(desk.db, id)).toMatchObject({
    outcome: "not started: cannot start",
    status: "ended",
  });
  expect(holderOf(desk.db, ["obs_00000000b002"])).toBeNull();
  // Not anchored for the inbox either: the new matter card comes back for another Start.
  expect(anchoredSteps(desk.db)).not.toContain("obs_00000000b002");
  expect(turns(id)).toEqual([{ cause: "deadline", outcome: "failed" }]);
});

test("a first turn whose run ends before it began ends its agent; one that had begun is retried", async () => {
  const { desk, fake, turns } = setup();
  fake.holdBegun();
  const lost = await started(desk, "obs_00000000b003");
  fake.exit(agentOf(desk.db, lost)?.session ?? "", false);
  await Bun.sleep(5);
  expect(agentOf(desk.db, lost)).toMatchObject({
    outcome: "not started: its first turn ended before it began",
    status: "ended",
  });

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
  fake.exit(ref, false, true);
  await Bun.sleep(5);
  expect(agentOf(desk.db, id)?.status).toBe("active");
  expect(turns(id)).toEqual([{ cause: "deadline", outcome: "failed" }]);
});

test("after a restart a first turn still running is under way: it is not ended as not started when it fails later", async () => {
  const { desk, fake, path } = setup();
  fake.holdBegun();
  const id = await started(desk, "obs_00000000b008");
  const ref = agentOf(desk.db, id)?.session ?? "";
  const again: Desk = { ...desk, db: openDesk(path) };
  await endLostTurns(again);
  expect(openTurn(again.db, id)?.begun_at).not.toBeNull();
  fake.exit(ref, false);
  await endLostTurns(again);
  expect(agentOf(again.db, id)?.status).toBe("active");
});
