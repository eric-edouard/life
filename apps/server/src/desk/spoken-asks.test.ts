import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { MIN, SECOND } from "../core/clock";
import { DESK_AGENT } from "../core/names";
import { setSettings } from "../core/settings";
import { ask, asksFor } from "../host/asks";
import { ASK_SPOKEN } from "../host/events";
import { LEDGER } from "../memory/memory-files";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as push from "../sources/lifelog-push";
import { eventLineOf, nextWakeOf } from "./agent-wait";
import { readPeopleOnce, wakeDue } from "./desk-clock";
import {
  closeAssignmentRow,
  readSpokenAsksCursor,
  saveSpokenAsksCursor,
} from "./desk-store";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as matterNet from "./matter-net";
import { standingAgentOf } from "./role-agents";
import { receiveSpokenAsks } from "./spoken-ask-intake";
import { advance, asgOf, setup } from "./test-desk";

// His spoken asks ("hey Life") from the ledger to one agent: a matter's by meaning, else the Personal agent, each once.
// Made-up words; the nets and the meaning read are given, not embedded.

afterEach(() => {
  setSystemTime();
  setSettings({ desk: null });
});

let n = 0;
/** His spoken ask, recorded now as the hearing records it. */
const spoken = (words = "remind me to water the test plant") => {
  n += 1;
  return ask(
    {
      at: new Date().toISOString(),
      quote: `hey Life, ${words} ${n}`,
      ref: `job${n}:0@x`,
    },
    {
      agent: DESK_AGENT,
      confidence: "high",
      conversation: `conv_${n}`,
      turns: [0],
    },
    "watch",
    "heard its wake"
  ).id;
};

/** A desk whose spoken-ask cursor starts past the ledger as it is (other tests' asks), Personal on `claude`. */
function deskOf(
  related: (text: string) => { isWhole: boolean; to?: string },
  duringRead: () => void = () => undefined
) {
  const s = setup();
  s.desk.runtimes.claude = s.fake.runtime;
  setSettings({ desk: { defaultRuntime: "claude", runtimes: {} } });
  const lines = existsSync(LEDGER)
    ? readFileSync(LEDGER, "utf8").split("\n").length - 1
    : 0;
  saveSpokenAsksCursor(s.desk.db, { line: lines, waiting: [] });
  const nets = spyOn(matterNet, "readNets").mockImplementation(() => {
    duringRead();
    return Promise.resolve({ isWhole: related("").isWhole, nets: [] });
  });
  const words = spyOn(matterNet, "relatedWords").mockImplementation(
    async (_d, _n, texts) => ({
      isWhole: true,
      related: texts.map((text) =>
        related(text).to
          ? [
              {
                assignment: related(text).to ?? "",
                by: { similarity: 0.712, why: "meaning" as const },
              },
            ]
          : []
      ),
    })
  );
  const receive = () => receiveSpokenAsks(s.desk, readPeopleOnce());
  const events = () =>
    s.desk.db
      .query<{ assignment_id: string; event_id: string; payload: string }, []>(
        `select assignment_id, event_id, payload from event where name = '${ASK_SPOKEN}' order by rowid`
      )
      .all();
  const done = () => {
    nets.mockRestore();
    words.mockRestore();
  };
  return { done, events, receive, s };
}

test("a spoken ask is the desk's to route, never pulled as a change", () => {
  const id = spoken();
  expect(
    asksFor(DESK_AGENT, undefined, 10_000).asks.map((a) => a.id)
  ).not.toContain(id);
});

test("a spoken ask close in meaning to a matter goes to its agent, facts only, once across restarts", async () => {
  let to = "";
  const d = deskOf(() => ({ isWhole: true, to }));
  try {
    to = asgOf(d.s.desk, await d.s.waiting());
    const before = readSpokenAsksCursor(d.s.desk.db);
    const id = spoken();
    await d.receive();
    // The cursor lost (a restart before it was saved): the receipt still holds.
    saveSpokenAsksCursor(d.s.desk.db, { ...before, waiting: [id] });
    await d.receive();
    const [e, ...more] = d.events();
    expect(more).toEqual([]);
    expect(e?.assignment_id).toBe(to);
    const payload = JSON.parse(e?.payload ?? "{}");
    expect(payload).toMatchObject({
      ask: id,
      by: { similarity: 0.71, why: "meaning" },
      conversation: `conv_${n}`,
      ref: `job${n}:0@x`,
    });
    expect(e?.payload).not.toContain("water");
    expect(standingAgentOf(d.s.desk.db, "personal")).toBeUndefined();
  } finally {
    d.done();
  }
});

test("with no matter close, the desk starts the Personal agent; with the embedder down it waits 20 s first", async () => {
  let isWhole = false;
  const d = deskOf(() => ({ isWhole }));
  try {
    const id = spoken();
    await d.receive();
    expect(d.events()).toEqual([]);
    expect(readSpokenAsksCursor(d.s.desk.db).waiting).toEqual([id]);
    advance(21 * SECOND);
    await d.receive();
    const personal = standingAgentOf(d.s.desk.db, "personal");
    expect(d.events().map((e) => [e.assignment_id, e.event_id])).toEqual([
      [asgOf(d.s.desk, personal?.id ?? ""), id],
    ]);
    expect(JSON.parse(d.events()[0]?.payload ?? "{}").by).toEqual({
      why: "personal",
    });
    expect(readSpokenAsksCursor(d.s.desk.db).waiting).toEqual([]);
    isWhole = true;
    // A whole read places a new ask at once.
    spoken();
    await d.receive();
    expect(d.events()).toHaveLength(2);
  } finally {
    d.done();
  }
});

test("a stopped Personal agent holds its ask back while a later matter's ask is delivered", async () => {
  let to: string | undefined;
  const d = deskOf((text) => ({
    isWhole: true,
    to: text.includes("repair") ? to : undefined,
  }));
  try {
    spoken();
    await d.receive();
    const personal = standingAgentOf(d.s.desk.db, "personal")?.id ?? "";
    d.s.desk.db.run("update agent set status = 'stopped' where id = ?", [
      personal,
    ]);
    const held = spoken();
    await d.receive();
    to = asgOf(d.s.desk, await d.s.waiting());
    const later = spoken("ask the plumber about the repair");
    await d.receive();
    expect(d.events().map((e) => e.event_id)).toContain(later);
    expect(d.events().map((e) => e.event_id)).not.toContain(held);
    expect(readSpokenAsksCursor(d.s.desk.db).waiting).toEqual([held]);
  } finally {
    d.done();
  }
});

test("an ask its assignment closed on unhanded is given back and routed again", async () => {
  let to: string | undefined;
  const d = deskOf(() => ({ isWhole: true, to }));
  try {
    const agent = await d.s.waiting();
    to = asgOf(d.s.desk, agent);
    const id = spoken();
    await d.receive();
    expect(d.events()[0]?.assignment_id).toBe(to);
    closeAssignmentRow(d.s.desk.db, to, { outcome: "done" });
    expect(d.events()).toEqual([]);
    expect(readSpokenAsksCursor(d.s.desk.db).waiting).toEqual([id]);
    to = undefined;
    await d.receive();
    const personal = standingAgentOf(d.s.desk.db, "personal")?.id ?? "";
    expect(d.events().map((e) => [e.assignment_id, e.event_id])).toEqual([
      [asgOf(d.s.desk, personal), id],
    ]);
  } finally {
    d.done();
  }
});

// life#1103: his words told to an agent that then ended waited for good; they go to the Personal agent, never by meaning.
test("his words told to one agent go there; its agent ended, to the Personal agent at once, never by meaning", async () => {
  const d = deskOf(() => ({ isWhole: false }));
  try {
    const to = asgOf(d.s.desk, await d.s.waiting());
    const told = (quote: string) =>
      ask(
        { at: new Date().toISOString(), quote, ref: `tell-life:${quote}` },
        { agent: DESK_AGENT, to },
        "connector",
        "his words through Tell Life to one agent"
      ).id;
    const facts = () =>
      d
        .events()
        .map((e) => [e.assignment_id, e.event_id, JSON.parse(e.payload).by]);
    const kept = told("book the test dentist");
    await d.receive();
    expect(facts()).toEqual([[to, kept, { to, why: "told" }]]);
    // Its agent ends: the unhanded ask is given back, and both it and a later one go to Personal.
    closeAssignmentRow(d.s.desk.db, to, { outcome: "done" });
    const late = told("move the test appointment");
    // The embedder is down: the Personal agent takes them now, without the 20 s wait for meaning.
    await d.receive();
    const personal = asgOf(
      d.s.desk,
      standingAgentOf(d.s.desk.db, "personal")?.id ?? ""
    );
    expect(facts()).toEqual([
      [personal, kept, { to, why: "told" }],
      [personal, late, { to, why: "told" }],
    ]);
    expect(readSpokenAsksCursor(d.s.desk.db).waiting).toEqual([]);
  } finally {
    d.done();
  }
});

test("a spoken ask wakes its agent at once, and says to confirm a low one", () => {
  const at = "2026-11-18T09:00:00.000Z";
  const event = {
    name: ASK_SPOKEN,
    payload: JSON.stringify({ ask: "entry_000000000001", confidence: "low" }),
    received_at: at,
  };
  expect(
    nextWakeOf({ opened_at: at, wait_until: "2026-11-19T09:00:00.000Z" }, [], [
      event,
    ] as never)
  ).toEqual({ at: Date.parse(at), cause: "answer" });
  expect(eventLineOf(event)).toContain("confirm it with him");
  expect(
    eventLineOf({ ...event, payload: '{"confidence":"high"}' })
  ).not.toContain("confirm");
});

test("he hears '<agent> heard you' once per ask, when the turn that hands it begins, never while queued or on a retry", async () => {
  const d = deskOf(() => ({ isWhole: true }));
  const pushes = spyOn(push, "notifyPhone").mockResolvedValue(true);
  try {
    spoken();
    spoken();
    await d.receive();
    expect(pushes).not.toHaveBeenCalled();
    await wakeDue(d.s.desk);
    await Bun.sleep(0);
    const heard: [push.Push] = [
      { body: "Your ask reached it.", title: "Personal heard you" },
    ];
    expect(pushes.mock.calls).toEqual([heard, heard]);
    // The turn fails; its retry hands the same asks again: no push.
    await d.s.end(standingAgentOf(d.s.desk.db, "personal")?.id ?? "", true);
    advance(6 * MIN);
    await wakeDue(d.s.desk);
    await Bun.sleep(0);
    expect(pushes.mock.calls).toHaveLength(2);
  } finally {
    pushes.mockRestore();
    d.done();
  }
});

test("a matter met on a read the embedder left partial is not taken: the ask waits, then goes to Personal at its own wait", async () => {
  let to: string | undefined;
  const d = deskOf(() => ({ isWhole: false, to }));
  try {
    to = asgOf(d.s.desk, await d.s.waiting());
    const id = spoken();
    await d.receive();
    expect(d.events()).toEqual([]);
    advance(21 * SECOND);
    await d.receive();
    const personal = standingAgentOf(d.s.desk.db, "personal")?.id ?? "";
    expect(d.events().map((e) => [e.assignment_id, e.event_id])).toEqual([
      [asgOf(d.s.desk, personal), id],
    ]);
  } finally {
    d.done();
  }
});

test("two asks sharing a stalled read: each falls back at its own wait, by the clock after the read", async () => {
  const d = deskOf(
    () => ({ isWhole: false }),
    () => advance(6 * SECOND)
  );
  try {
    const old = spoken();
    advance(15 * SECOND);
    const young = spoken();
    await d.receive();
    expect(d.events().map((e) => e.event_id)).toEqual([old]);
    expect(readSpokenAsksCursor(d.s.desk.db).waiting).toEqual([young]);
  } finally {
    d.done();
  }
});

test("a read that fails is logged and not whole: an ask past its wait still goes to Personal", async () => {
  const d = deskOf(() => ({ isWhole: true }));
  const fail = spyOn(matterNet, "readNets").mockRejectedValue(
    new Error("matter book unreadable")
  );
  try {
    const id = spoken();
    advance(21 * SECOND);
    await d.receive();
    expect(d.events().map((e) => e.event_id)).toEqual([id]);
  } finally {
    fail.mockRestore();
    d.done();
  }
});

test("an ask given back while another is being read is kept waiting, never lost", async () => {
  let to: string | undefined;
  let closing = false;
  const d = deskOf(
    () => ({ isWhole: true, to }),
    () => {
      if (closing) {
        closeAssignmentRow(d.s.desk.db, to ?? "", { outcome: "done" });
        to = undefined;
      }
    }
  );
  try {
    to = asgOf(d.s.desk, await d.s.waiting());
    const first = spoken();
    await d.receive();
    expect(d.events().map((e) => e.event_id)).toEqual([first]);
    closing = true;
    spoken("x".repeat(30));
    // No Personal place now: the given-back ask can only wait.
    d.s.fake.blocked = "signed out";
    await d.receive();
    expect(readSpokenAsksCursor(d.s.desk.db).waiting).toContain(first);
  } finally {
    d.done();
  }
});
