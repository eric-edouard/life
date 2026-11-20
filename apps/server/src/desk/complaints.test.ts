import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { clock } from "../core/clock";
import { DESK_AGENT } from "../core/names";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import { asksFor } from "../host/asks";
import { complain, type Misread } from "../host/complaints";
import {
  agentInRole,
  complaintsAtWork,
  currentAssignmentOf,
} from "../host/desk-read";
import { COMPLAINTS } from "../memory/complaints";
import { LEDGER, readLedger } from "../memory/memory-files";
import { complaintOf, isComplaint } from "../records/ledger-entry";
import { CARETAKER_BRIEF, receiveComplaints } from "./complaint-intake";
import { doorFetch, doorOf } from "./desk-door";
import { closeAssignmentRow, type Desk, openDesk } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";

// His complaint ("Wrong…" on a card of Life's) from his press to the caretaker's door: one ask per press key, its row in
// the complaint record, its receipt on the caretaker's assignment, and only then `reached`. Made-up cards and words.

const fake = fakeRuntime();
let desk: Desk;
let inbox: { mockRestore: () => void } | undefined;
const CARD = {
  group: "name",
  misread: { cause: "cause-dre", shown: "shown-dre" },
  question: 'Who is "Dre"?',
  ref: "name:dre",
};
const AGENT_CARD = {
  group: "decision",
  misread: null,
  ref: "dec_00000000000d",
};
const WORDS = "Dre is my cousin Mina, not a stranger";
const ENTRY_ID = /^entry_/;
const ON_CARD: Misread = {
  cause: "cause-dre",
  kind: "misread",
  report: false,
  shown: "shown-dre",
};

/** A press on `ref`, the desk receiving every 100 ms meanwhile. */
async function press(
  key: string,
  over: Partial<Misread> = {},
  { limitMs = 3000, ref = CARD.ref, words = WORDS } = {}
) {
  const timer = setInterval(() => receiveComplaints(desk), 100);
  try {
    return await complain(
      ref,
      words,
      { ...ON_CARD, ...over },
      { answerKey: key, report: () => undefined },
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
    [first.ask, second.ask].map((ask) => ({
      assignment_id: asg,
      event_id: ask,
      payload: JSON.stringify({ ask }),
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
        ref: CARD.ref,
        report,
        shown: "shown-dre",
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
    "Life's own cards only"
  );
  await expect(
    complain(CARD.ref, " ", ON_CARD, {
      answerKey: "key-8",
      report: () => undefined,
    })
  ).rejects.toThrow("his words");
  await expect(
    complain(CARD.ref, WORDS, ON_CARD, { report: () => undefined })
  ).rejects.toThrow("life/answerKey");
  expect(readLedger()).toHaveLength(before);
});

test("a stopped caretaker leaves a press unreceived, his words kept; it is received once it resumes; one a caretaker received is never received again after it finished, and a new press starts a new caretaker", async () => {
  const caretaker = agentInRole(desk.db, "caretaker")?.id ?? "";
  desk.db.run("update agent set status = 'stopped' where id = ?", [caretaker]);
  await expect(press("key-3", {}, { limitMs: 500 })).rejects.toThrow(
    "the desk has not received it in 0.5 s. His words are recorded"
  );
  desk.db.run("update agent set status = 'active' where id = ?", [caretaker]);
  const third = await press("key-3");
  expect(received().at(-1)?.event_id).toBe(third.ask);
  // It finished: its assignment closed, the caretaker ended.
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
});

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
    ref: CARD.ref,
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
