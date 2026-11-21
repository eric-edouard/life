import {
  afterAll,
  beforeAll,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { clock } from "../core/clock";
import { DESK_AGENT } from "../core/names";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import { agentsNow } from "../host/agents-now";
import { ask, asksFor } from "../host/asks";
import { complainThroughTellLife } from "../host/complaints";
import {
  agentInRole,
  beingFixedOf,
  complaintReceiptOf,
  complaintsAtWork,
  currentAssignmentOf,
} from "../host/desk-read";
import { COMPLAINTS, stageOf } from "../memory/complaint-record";
import type { DecisionState } from "../memory/decision-lines";
import { LEDGER, readLedger } from "../memory/memory-files";
import { complaintOf, isComplaint } from "../records/ledger-entry";
import { readPacket } from "./agent-actions";
import { CARETAKER_BRIEF, receiveComplaints } from "./complaint-intake";
import { wakeDue } from "./desk-clock";
import { doorFetch } from "./desk-door";
import { closeAssignmentRow, type Desk, openDesk } from "./desk-store";
import { doorOf } from "./door-keys";
import { fakeRuntime } from "./runtimes/fake-runtime";

// His complaint (his words through Tell Life) to the caretaker's door: one ask per key, its row in the complaint record,
// its receipt on the caretaker's assignment, and only then `reached`. Made-up cards and words.

const fake = fakeRuntime();
let desk: Desk;
let inbox: { mockRestore: () => void } | undefined;
const CARD = {
  confirm: [],
  group: "name",
  misread: { cause: "cause-dre" },
  question: 'Who is "Dre"?',
  ref: "name:dre",
};
const WORDS = "Dre is my cousin Mina, not a stranger";
const ENTRY_ID = /^entry_/;

/** His complaint through Tell Life on card `name:dre`, under ask key `key`, the desk receiving every 100 ms meanwhile. */
async function tell(key: string, { limitMs = 3000, report = false } = {}) {
  const timer = setInterval(() => receiveComplaints(desk), 100);
  try {
    return await complainThroughTellLife(
      WORDS,
      "name:dre",
      report,
      key,
      limitMs
    );
  } finally {
    clearInterval(timer);
  }
}

/** A made-up caretaker card asked on assignment `assignment`. */
const caretakerCard = (id: string, assignment: string, agent = "agt_x") => ({
  agent,
  assignment,
  context: "I read the card as shown.",
  id,
  question: "Is Dre your cousin?",
  state: "open" as DecisionState,
});
/** His complaints at work as cards show them, over `cards`. */
const shown = (cards: ReturnType<typeof caretakerCard>[]) =>
  beingFixedOf(desk.db, cards);
const received = () =>
  desk.db
    .query<{ assignment_id: string; event_id: string; payload: string }, []>(
      "select assignment_id, event_id, payload from event where name = 'complaint.received' order by rowid"
    )
    .all();

beforeAll(async () => {
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  rmSync(LEDGER, { force: true });
  rmSync(COMPLAINTS, { force: true });
  setSettings({ desk: { defaultRuntime: "claude", runtimes: {} } });
  desk = { db: openDesk(), runtimes: { claude: fake.runtime } };
  inbox = spyOn(
    await import("../host/inbox"),
    "openChecksNow"
  ).mockResolvedValue([CARD] as never);
});

afterAll(() => {
  inbox?.mockRestore();
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  rmSync(LEDGER, { force: true });
  rmSync(COMPLAINTS, { force: true });
  setSettings({ desk: null });
});

test("a complaint reaches the caretaker once its ask, its row and its receipt are written; its key's repeat is the first; a new key is a second complaint on the same assignment", async () => {
  const first = await tell("key-1");
  expect(first).toEqual({
    ask: expect.stringMatching(ENTRY_ID),
    reached: "caretaker",
  });
  expect(await tell("key-1")).toEqual(first);
  const second = await tell("key-2", { report: true });
  expect(second.ask).not.toBe(first.ask);
  const caretaker = agentInRole(desk.db, "caretaker");
  expect(caretaker).toMatchObject({ brief: CARETAKER_BRIEF, status: "active" });
  const asg = currentAssignmentOf(desk.db, caretaker?.id ?? "")?.id ?? "";
  expect(received()).toEqual(
    [first.ask, second.ask].map((id) => ({
      assignment_id: asg,
      event_id: id,
      payload: JSON.stringify({ ask: id }),
    }))
  );
  const asks = readLedger().filter(isComplaint);
  expect(asks.map((a) => [a.instruction?.quote, complaintOf(a)])).toEqual(
    [false, true].map((report) => [
      WORDS,
      {
        card: CARD,
        cause: "cause-dre",
        kind: "name",
        prompt: null,
        ref: "name:dre",
        report,
        stage: "names",
      },
    ])
  );
  expect(
    readFileSync(COMPLAINTS, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
  ).toEqual(
    asks.map((a) => ({
      ask: a.id,
      at: a.at,
      kind: "name",
      prompt: null,
      schemaVersion: 1,
      stage: "names",
    }))
  );
  // Never pulled as an ask, never fed, never listed.
  expect(asksFor(DESK_AGENT).asks).toEqual([]);
  // Two complaints on one assignment: neither shows the caretaker's open card, which may be about the other.
  const both = received()[0]?.assignment_id ?? "";
  expect(
    shown([caretakerCard("dec_both", both)]).map((w) => [
      w.ask,
      w.line,
      w.context,
    ])
  ).toEqual([
    [first.ask, null, null],
    [second.ask, null, null],
  ]);
});

test("a stopped caretaker leaves a complaint unreceived, his words kept; it is received once it resumes; one a caretaker received is never received again after it finished, and a new complaint starts a new caretaker", async () => {
  const caretaker = agentInRole(desk.db, "caretaker")?.id ?? "";
  desk.db.run("update agent set status = 'stopped' where id = ?", [caretaker]);
  await expect(tell("key-3", { limitMs: 600 })).rejects.toThrow(
    "the desk has not received it in 0.6 s. His words are recorded"
  );
  desk.db.run("update agent set status = 'active' where id = ?", [caretaker]);
  const third = await tell("key-3");
  expect(received().at(-1)?.event_id).toBe(third.ask);
  // It finished, every complaint handed to its turns: its assignment closed, the caretaker ended.
  desk.db.run("update event set handed = 1");
  const asg = currentAssignmentOf(desk.db, caretaker)?.id ?? "";
  desk.db.transaction(() =>
    closeAssignmentRow(desk.db, asg, { outcome: "all three handled" })
  )();
  expect(complaintsAtWork(desk.db)).toEqual([]);
  desk.db.run("delete from cursor where name = 'complaints'");
  await receiveComplaints(desk);
  expect(received()).toHaveLength(3);
  expect(await tell("key-3")).toEqual(third);
  const fourth = await tell("key-4");
  const next = agentInRole(desk.db, "caretaker");
  expect(next?.id).not.toBe(caretaker);
  // A complaint alone on its assignment shows the caretaker's newest open card there: its question and context.
  const nextAsg = currentAssignmentOf(desk.db, next?.id ?? "")?.id ?? "";
  const card = caretakerCard("dec_open", nextAsg, next?.id);
  const alone = (cards: (typeof card)[]) =>
    shown(cards).map(({ context, line }) => ({
      context,
      line,
    }));
  expect(shown([card])).toEqual([
    {
      ask: fourth.ask,
      context: "I read the card as shown.",
      line: "Is Dre your cousin?",
      since: expect.any(String),
    },
  ]);
  // No open card: the plain line. An answered or withdrawn card never shows.
  const none = [{ context: null, line: null }];
  expect(alone([])).toEqual(none);
  expect(alone([{ ...card, state: "answered" }])).toEqual(none);
  expect(alone([{ ...card, state: "withdrawn" }])).toEqual(none);
  // A newer card of another open assignment never shows.
  desk.db.run(
    "insert into assignment (id, agent_id, opened_at, opened_by, notes_path, wait_until) select 'asg_other', agent_id, opened_at, opened_by, notes_path, wait_until from assignment where id = ?",
    [nextAsg]
  );
  const other = {
    ...caretakerCard("dec_other", "asg_other", next?.id),
    context: "Another complaint's card.",
    question: "Is this another card?",
  };
  expect(alone([card, other])).toEqual([
    { context: "I read the card as shown.", line: "Is Dre your cousin?" },
  ]);
  desk.db.run("delete from assignment where id = 'asg_other'");
}, 15_000);

test("the caretaker reads a complaint through its door only on the assignment that received it, and waits with no plan card first", async () => {
  const id = agentInRole(desk.db, "caretaker")?.id ?? "";
  const [, , , fourth] = received();
  desk.db.run(
    "insert into turn (agent_id, assignment_id, cause, started_at) values (?, ?, 'first turn', ?)",
    [id, fourth?.assignment_id ?? "", clock().toISOString()]
  );
  const call = async (name: string, args: object) => {
    const res = await doorFetch(desk)(
      new Request(`http://127.0.0.1/mcp/${id}`, {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: args, name },
        }),
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${doorOf(id).key}`,
          "content-type": "application/json",
        },
        method: "POST",
      })
    );
    const data = (await res.text())
      .split("\n")
      .find((l) => l.startsWith("data:"));
    return JSON.parse(data?.slice(5) ?? "{}").result as {
      content: { text: string }[];
      isError?: boolean;
    };
  };
  const mine = await call("read_complaint", { ask: fourth?.event_id });
  expect(JSON.parse(mine.content[0]?.text ?? "")).toMatchObject({
    card: CARD,
    ref: "name:dre",
    report: false,
    words: WORDS,
  });
  const [first] = received();
  const other = await call("read_complaint", { ask: first?.event_id });
  expect(other.isError).toBe(true);
  expect(other.content[0]?.text).toContain("was received here");
  const wait = await call("set_wait", {
    events: [],
    reason: "his next complaint",
    until: new Date(clock().getTime() + 3_600_000).toISOString(),
  });
  expect(wait.isError).toBeFalsy();
});

test("a caretaker that finishes while a complaint it never handed waits gives it back: received again for a caretaker that reads it, its receipt never stranded on a closed assignment", async () => {
  // Its turn had every complaint so far: handed.
  desk.db.run("update event set handed = 1");
  const b = await tell("key-5");
  const before = complaintReceiptOf(desk.db, b.ask);
  expect(before?.assignment).toBeTruthy();
  // It finishes the complaints it handled: B came after its turn began.
  desk.db.transaction(() =>
    closeAssignmentRow(desk.db, before?.assignment ?? "", {
      outcome: "handled the earlier ones",
    })
  )();
  expect(complaintReceiptOf(desk.db, b.ask)).toBeNull();
  await receiveComplaints(desk);
  const after = complaintReceiptOf(desk.db, b.ask);
  expect(after?.assignment).not.toBe(before?.assignment);
  expect(
    currentAssignmentOf(desk.db, agentInRole(desk.db, "caretaker")?.id ?? "")
      ?.id
  ).toBe(after?.assignment);
  expect(await tell("key-5")).toEqual(b);
});

/** His complaint as Tell Life asks it, under key `key`, with nothing after it (no row, no receipt): as a crash leaves it. */
const askedOnly = (key: string) =>
  ask(
    { at: clock().toISOString(), quote: WORDS, ref: `complaint:${key}` },
    {
      agent: DESK_AGENT,
      complaint: {
        card: CARD,
        cause: "cause-dre",
        ...stageOf(CARD),
        ref: "name:dre",
        report: false,
      },
    },
    "connector",
    "test"
  );

test("a crash after the ask, before its row and receipt: the desk's next tick writes both, with no second ask", async () => {
  const asked = askedOnly("key-crash");
  expect(readFileSync(COMPLAINTS, "utf8")).not.toContain(asked.id);
  await receiveComplaints(desk);
  expect(readFileSync(COMPLAINTS, "utf8")).toContain(asked.id);
  expect(complaintReceiptOf(desk.db, asked.id)).toBeTruthy();
});

test("the caretaker's notes stay out of its row; its packet names Life's data and no plan", async () => {
  const id = agentInRole(desk.db, "caretaker")?.id ?? "";
  const s = currentAssignmentOf(desk.db, id);
  await Bun.write(s?.notes_path ?? "", "Mina is his cousin\n");
  expect(
    agentsNow(desk.db, clock().getTime()).find((a) => a.id === id)?.notes
  ).toBe("");
  const packet = await readPacket(desk, s as never, true);
  expect(packet).toContain("Your subject: Life's data.");
  expect(packet).toContain("ask no plan card and wait for no `start`");
  expect(packet).not.toContain("asks your plan");
});

test("a caretaker whose first launch fails is not registered again for the same complaint: it waits, unreceived, for his next complaint", async () => {
  // The caretaker so far handled everything and finished.
  desk.db.run("update event set handed = 1");
  const done = agentInRole(desk.db, "caretaker");
  desk.db.transaction(() =>
    closeAssignmentRow(
      desk.db,
      currentAssignmentOf(desk.db, done?.id ?? "")?.id ?? "",
      { outcome: "all handled" }
    )
  )();
  const caretakers = () =>
    desk.db
      .query<{ n: number }, []>(
        "select count(*) as n from agent where role = 'caretaker'"
      )
      .get()?.n ?? 0;
  const before = caretakers();
  fake.isFailing = true;
  try {
    const stuck = askedOnly("key-launch");
    for (const _ of [1, 2, 3]) {
      // biome-ignore lint/performance/noAwaitInLoops: one tick after another
      await receiveComplaints(desk);
      await wakeDue(desk);
    }
    expect(caretakers()).toBe(before + 1);
    expect(agentInRole(desk.db, "caretaker")).toMatchObject({
      status: "ended",
      why_not_started: expect.any(String),
    });
    expect(complaintReceiptOf(desk.db, stuck.id)).toBeNull();
    // His next complaint tries once more, taking the one still waiting with it, even when a thousand asks for other
    // agents came between: past the intake's window.
    setSystemTime(new Date(clock().getTime() + 60_000));
    appendFileSync(
      LEDGER,
      Array.from(
        { length: 1000 },
        (_, i) =>
          `${JSON.stringify({
            after: { agent: "test-filler" },
            at: clock().toISOString(),
            id: `entry_${(0xf0_00_00_00_00_00 + i).toString(16)}`,
            instruction: {
              at: clock().toISOString(),
              quote: "Test",
              ref: `t:${i}`,
            },
            kind: "ask",
            result: "ok",
            schemaVersion: 1,
            target: "agent",
            via: "connector",
            why: "test",
          })}\n`
      ).join("")
    );
    const next = askedOnly("key-launch-2");
    await receiveComplaints(desk);
    expect(caretakers()).toBe(before + 2);
    await receiveComplaints(desk);
    expect(complaintReceiptOf(desk.db, stuck.id)?.assignment).toBe(
      complaintReceiptOf(desk.db, next.id)?.assignment
    );
  } finally {
    fake.isFailing = false;
    setSystemTime();
  }
});
