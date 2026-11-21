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
import { secretIn } from "../core/secret";
import { setSettings } from "../core/settings";
import { ask, asksFor } from "../host/asks";
import { complain, type Misread } from "../host/complaints";
import {
  agentInRole,
  agentsNow,
  complaintReceiptOf,
  complaintsAtWork,
  currentAssignmentOf,
} from "../host/desk-read";
import { cut } from "../host/http/mcp-tool";
import {
  type MisreadShown,
  withMisreadSealed,
} from "../memory/complaint-checks";
import { COMPLAINTS, stageOf } from "../memory/complaint-record";
import { LEDGER, readLedger } from "../memory/memory-files";
import { complaintOf, isComplaint } from "../records/ledger-entry";
import { readPacket } from "./agent-actions";
import { CARETAKER_BRIEF, receiveComplaints } from "./complaint-intake";
import { wakeDue } from "./desk-clock";
import { doorFetch, doorOf } from "./desk-door";
import { closeAssignmentRow, type Desk, openDesk } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";

// His complaint ("Wrong…" on a card of Life's) from his press to the caretaker's door: one ask per press key, its row in
// the complaint record, its receipt on the caretaker's assignment, and only then `reached`. Made-up cards and words.

const fake = fakeRuntime();
let desk: Desk;
let inbox: { mockRestore: () => void } | undefined;
const [CARD] = withMisreadSealed(
  [
    {
      confirm: [],
      group: "name",
      misread: { cause: "cause-dre" },
      question: 'Who is "Dre"?',
      ref: "name:dre",
    },
  ],
  secretIn("pushIdKey")
);
const AGENT_CARD = {
  group: "decision",
  misread: null,
  ref: "dec_00000000000d",
};
const WORDS = "Dre is my cousin Mina, not a stranger";
const ENTRY_ID = /^entry_/;
const SEALED = CARD?.misread as MisreadShown;
const ON_CARD: Misread = { ...SEALED, kind: "misread", report: false };

/** A press on `ref`, the desk receiving every 100 ms meanwhile. */
async function press(
  key: string,
  over: Partial<Misread> = {},
  {
    limitMs = 3000,
    ref = "name:dre",
    report = () => undefined,
    words = WORDS,
  }: {
    limitMs?: number;
    ref?: string;
    report?: (step: Record<string, unknown>) => void;
    words?: string;
  } = {}
) {
  const timer = setInterval(() => receiveComplaints(desk), 100);
  try {
    return await complain(
      ref,
      words,
      { ...ON_CARD, ...over },
      { answerKey: key, report },
      limitMs
    );
  } finally {
    clearInterval(timer);
  }
}

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
  ).mockResolvedValue([CARD, AGENT_CARD] as never);
});

afterAll(() => {
  inbox?.mockRestore();
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  rmSync(LEDGER, { force: true });
  rmSync(COMPLAINTS, { force: true });
  setSettings({ desk: null });
});

test("a press reaches the caretaker once its ask, its row and its receipt are written; its key's retry resumes it; a new key is a second complaint on the same assignment", async () => {
  const first = await press("key-1");
  expect(first).toEqual({
    ask: expect.stringMatching(ENTRY_ID),
    reached: "caretaker",
  });
  expect(await press("key-1")).toEqual(first);
  const second = await press("key-2", { report: true });
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
        isAsShown: true,
        kind: "name",
        prompt: null,
        ref: "name:dre",
        report,
        shown: SEALED.shown,
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
  // Two complaints on one assignment: neither shows its line.
  desk.db.run("update assignment set plan_now = 'Reading the card'");
  expect(complaintsAtWork(desk.db).map((w) => [w.ask, w.line])).toEqual([
    [first.ask, null],
    [second.ask, null],
  ]);
});

test("the same key with other words, tick or card, a card of an agent's, no key or no words, are refused; nothing more is recorded", async () => {
  const before = readLedger().length;
  await expect(press("key-1", { report: true })).rejects.toThrow(
    "this key recorded another press"
  );
  await expect(
    press("key-1", {}, { words: "Dre is my neighbour" })
  ).rejects.toThrow("this key recorded another press");
  await expect(press("key-9", {}, { ref: AGENT_CARD.ref })).rejects.toThrow(
    "a card of Life's as Life showed it"
  );
  // A retry under a recorded key is checked too: a seal Life never made is refused, not taken as the press it repeats.
  await expect(press("key-1", { seal: "f".repeat(32) })).rejects.toThrow(
    "a card of Life's as Life showed it"
  );
  await expect(
    complain("name:dre", " ", ON_CARD, {
      answerKey: "key-8",
      report: () => undefined,
    })
  ).rejects.toThrow("his words");
  await expect(
    complain("name:dre", WORDS, ON_CARD, { report: () => undefined })
  ).rejects.toThrow("life/answerKey");
  expect(readLedger()).toHaveLength(before);
});

test("a stopped caretaker leaves a press unreceived, his words kept, its plan said again every 5 s so the phone's stream stays open; it is received once it resumes; one a caretaker received is never received again after it finished, and a new press starts a new caretaker", async () => {
  const caretaker = agentInRole(desk.db, "caretaker")?.id ?? "";
  desk.db.run("update agent set status = 'stopped' where id = ?", [caretaker]);
  const said: Record<string, unknown>[] = [];
  await expect(
    press("key-3", {}, { limitMs: 5500, report: (s) => said.push(s) })
  ).rejects.toThrow(
    "the desk has not received it in 5.5 s. His words are recorded"
  );
  expect(said.map((s) => s.step ?? "plan")).toEqual([
    "plan",
    "recorded",
    "plan",
  ]);
  // Only the first plan says the limit: said again, it would move the phone's deadline.
  expect(said.map((s) => s.limitSeconds)).toEqual([5.5, undefined, undefined]);
  desk.db.run("update agent set status = 'active' where id = ?", [caretaker]);
  const third = await press("key-3");
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
  expect(await press("key-3")).toEqual(third);
  const fourth = await press("key-4");
  const next = agentInRole(desk.db, "caretaker");
  expect(next?.id).not.toBe(caretaker);
  // A complaint alone on its assignment shows that assignment's line.
  desk.db.run(
    "update assignment set plan_now = 'Reading the card' where agent_id = ?",
    [next?.id ?? ""]
  );
  expect(complaintsAtWork(desk.db)).toEqual([
    { ask: fourth.ask, line: "Reading the card", since: expect.any(String) },
  ]);
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
  const b = await press("key-5");
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
  expect(await press("key-5")).toEqual(b);
});

/** His complaint as a press asks it, under key `key`, with nothing after it (no row, no receipt): as a crash leaves it. */
const askedOnly = (key: string) =>
  ask(
    { at: clock().toISOString(), quote: WORDS, ref: `complaint:${key}` },
    {
      agent: DESK_AGENT,
      complaint: {
        card: CARD,
        cause: "cause-dre",
        isAsShown: true,
        ...stageOf(CARD),
        ref: "name:dre",
        report: false,
        shown: SEALED.shown,
      },
    },
    "connector",
    "test"
  );

test("a crash after the ask, before its row and receipt: the desk's next tick writes both, with no second press", async () => {
  const asked = askedOnly("key-crash");
  expect(readFileSync(COMPLAINTS, "utf8")).not.toContain(asked.id);
  await receiveComplaints(desk);
  expect(readFileSync(COMPLAINTS, "utf8")).toContain(asked.id);
  expect(complaintReceiptOf(desk.db, asked.id)).toBeTruthy();
});

test("his complaint's words stay out of the call log, the caretaker's notes out of its row; its packet names Life's data and no plan", async () => {
  const logged = JSON.stringify(
    cut({ note: WORDS, ref: "name:dre", value: ON_CARD })
  );
  expect(logged).not.toContain("cousin");
  const id = agentInRole(desk.db, "caretaker")?.id ?? "";
  const s = currentAssignmentOf(desk.db, id);
  await Bun.write(s?.notes_path ?? "", "Mina is his cousin\n");
  expect(
    agentsNow(desk.db, clock().getTime()).find((a) => a.id === id)?.notes
  ).toBe("");
  const packet = await readPacket(desk, s as never, true);
  expect(packet).toContain("Your subject: Life's data.");
  expect(packet).toContain("ask no plan and wait for no Go");
  expect(packet).not.toContain("asks your plan");
});

test("a caretaker whose first launch fails is not registered again for the same complaint: it waits, unreceived, for his next press", async () => {
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
    // His next press tries once more, taking the one still waiting with it, even when a thousand asks for other
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

test("his own retry under the key of a press whose caretaker never started tries once more, a repeat or a replay never: one complaint, one receipt", async () => {
  desk.db.run("update event set handed = 1");
  const last = agentInRole(desk.db, "caretaker");
  if (last?.status === "active") {
    desk.db.transaction(() =>
      closeAssignmentRow(
        desk.db,
        currentAssignmentOf(desk.db, last.id)?.id ?? "",
        { outcome: "all handled" }
      )
    )();
  }
  // Past every press so far: the last test's clock went ahead.
  setSystemTime(new Date(clock().getTime() + 120_000));
  fake.isFailing = true;
  try {
    const stuck = askedOnly("key-relaunch");
    for (const _ of [1, 2, 3]) {
      // biome-ignore lint/performance/noAwaitInLoops: one tick after another
      await receiveComplaints(desk);
      await wakeDue(desk);
    }
    expect(agentInRole(desk.db, "caretaker")?.why_not_started).toBeTruthy();
    expect(complaintReceiptOf(desk.db, stuck.id)).toBeNull();
    fake.isFailing = false;
    setSystemTime(new Date(clock().getTime() + 60_000));
    // The runtime answers again, but neither his app's repeat of a dropped call nor a replay of a complaint received
    // long ago is his press: no caretaker is started for them.
    const caretakers = agentInRole(desk.db, "caretaker")?.id;
    await expect(
      press("key-relaunch", { repeated: true }, { limitMs: 600 })
    ).rejects.toThrow("has not received it");
    expect((await press("key-1")).reached).toBe("caretaker");
    await receiveComplaints(desk);
    expect(agentInRole(desk.db, "caretaker")?.id).toBe(caretakers);
    // His "Try again" sends the same press, under its key: the caretaker tries once more.
    expect(await press("key-relaunch")).toEqual({
      ask: stuck.id,
      reached: "caretaker",
    });
    expect(
      readLedger().filter(
        (a) => a.instruction?.ref === "complaint:key-relaunch"
      )
    ).toHaveLength(1);
    expect(received().filter((r) => r.event_id === stuck.id)).toHaveLength(1);
  } finally {
    fake.isFailing = false;
    setSystemTime();
  }
});
