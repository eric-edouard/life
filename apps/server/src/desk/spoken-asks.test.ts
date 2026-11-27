import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { DESK_AGENT } from "../core/names";
import { setSettings } from "../core/settings";
import { ask, asksFor } from "../host/asks";
import { ASK_SPOKEN } from "../host/events";
import { LEDGER } from "../memory/memory-files";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as push from "../sources/lifelog-push";
import { PUSH_ID } from "../sources/lifelog-push";
import {
  closeAssignmentRow,
  readSpokenAsksCursor,
  saveSpokenAsksCursor,
} from "./desk-store";
import { standingAgentOf } from "./role-agents";
import { CUT_BY_RESTART, receiveSpokenAsks } from "./spoken-ask-intake";
import { asgOf, callDoorOf, setup } from "./test-desk";

// His spoken asks ("hey Life") from the ledger: each one ask of the main session, which always ends with something he
// sees (his decisions of 27 Nov 2026: "The main session", "Yes, always reply"); his words the main session told one
// agent, to that agent. Made-up words.

afterEach(() => setSettings({ desk: null }));

let n = 0;
/** His spoken ask, recorded now as the hearing records it. */
const spoken = (words = "add test milk to my list", confidence = "high") => {
  n += 1;
  return ask(
    {
      at: new Date().toISOString(),
      quote: `hey Life, ${words} ${n}`,
      ref: `job${n}:0@x`,
    },
    { agent: DESK_AGENT, confidence, conversation: `conv_${n}`, turns: [0] },
    "watch",
    "heard its wake"
  ).id;
};

/** A desk whose spoken-ask cursor starts past the ledger as it is (other tests' asks), the main session on the fake runtime. */
function deskOf() {
  const s = setup();
  s.desk.runtimes = { pi: s.fake.runtime };
  setSettings({ desk: { runtimes: {} } });
  const lines = existsSync(LEDGER)
    ? readFileSync(LEDGER, "utf8").split("\n").length - 1
    : 0;
  saveSpokenAsksCursor(s.desk.db, { line: lines, waiting: [] });
  const receive = () => receiveSpokenAsks(s.desk);
  /** Waits until the main session was given `count` messages; the last one's session. */
  const toldMain = async (count: number) => {
    for (let i = 0; i < 40 && s.fake.said.length < count; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: a poll
      await Bun.sleep(5);
    }
    return s.fake.said.at(-1)?.ref ?? "";
  };
  const entryOf = (id: string) =>
    s.desk.db
      .query<
        {
          answer: string | null;
          answered_at: string | null;
          error: string | null;
          reactions: string;
          words: string;
        },
        [string]
      >(
        "select words, answer, error, answered_at, reactions from thread_entry where ask_key = ?"
      )
      .get(id);
  return { entryOf, receive, s, toldMain };
}

/** Lets the ask's end settle (its answer written after the run ends). */
const settle = async () => {
  for (let i = 0; i < 10; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: a settle
    await Bun.sleep(5);
  }
};

test("a spoken ask is the desk's to route, never pulled as a change", () => {
  const id = spoken();
  expect(
    asksFor(DESK_AGENT, undefined, 10_000).asks.map((a) => a.id)
  ).not.toContain(id);
});

test("a spoken ask is one ask of the main session: his words in his thread with Life's eyes, one push, then its answer; asked once", async () => {
  const d = deskOf();
  const pushes = spyOn(push, "notifyPhone").mockResolvedValue(true);
  try {
    const id = spoken();
    await d.receive();
    const ref = await d.toldMain(1);
    expect(d.s.fake.said.at(-1)?.message).toContain(
      `His words, spoken to Life ("hey Life", turn 0 of conversation \`conv_${n}\`): "hey Life, add test milk to my list ${n}"`
    );
    expect(d.entryOf(id)).toMatchObject({
      answered_at: null,
      words: `hey Life, add test milk to my list ${n}`,
    });
    expect(JSON.parse(d.entryOf(id)?.reactions ?? "[]")).toMatchObject([
      { by: "life", with: "👀" },
    ]);
    // Never his words through Apple.
    const pushId = expect.stringMatching(PUSH_ID);
    expect(pushes.mock.calls).toEqual([
      [{ body: "On it.", pushId, title: "Life heard you" }],
    ]);
    // A tick while it runs (and a lost cursor) asks nothing again.
    saveSpokenAsksCursor(d.s.desk.db, {
      ...readSpokenAsksCursor(d.s.desk.db),
      waiting: [id],
    });
    await d.receive();
    d.s.fake.hear(ref, { kind: "words", text: "Added test milk." });
    d.s.fake.exit(ref, true);
    await settle();
    expect(d.entryOf(id)).toMatchObject({ answer: "Added test milk." });
    await d.receive();
    expect(readSpokenAsksCursor(d.s.desk.db).waiting).toEqual([]);
    expect(d.s.fake.said).toHaveLength(1);
    // Its answer replaces the heard push: the same id, still no words.
    expect(pushes.mock.calls).toEqual([
      [{ body: "On it.", pushId, title: "Life heard you" }],
      [{ body: "Open Life to read it.", pushId, title: "Life answered" }],
    ]);
    expect(pushes.mock.calls[1]?.[0].pushId).toBe(
      pushes.mock.calls[0]?.[0].pushId
    );
    // No agent was woken for it.
    expect(standingAgentOf(d.s.desk.db, "personal")).toBeUndefined();
  } finally {
    pushes.mockRestore();
  }
});

// The guard (his "Yes, always reply" of 27 Nov 2026): every spoken ask ends with a line he sees, whatever its turn did.
test("every spoken ask ends with an answer or an error in his thread: a reply, no answer, a failed run, a session that won't talk, a restart", async () => {
  const d = deskOf();
  const pushes = spyOn(push, "notifyPhone").mockResolvedValue(true);
  try {
    const ends: ((ref: string) => void)[] = [
      (ref) => {
        d.s.fake.hear(ref, { kind: "words", text: "Done." });
        d.s.fake.exit(ref, true);
      },
      (ref) => d.s.fake.exit(ref, true),
      (ref) => d.s.fake.exit(ref, false, { why: "out of quota" }),
    ];
    const ids: string[] = [];
    for (const end of ends) {
      ids.push(spoken());
      // biome-ignore lint/performance/noAwaitInLoops: one ask at a time, as the main session takes them
      await d.receive();
      end(await d.toldMain(ids.length));
      await settle();
    }
    d.s.fake.isFailing = true;
    ids.push(spoken());
    await d.receive();
    await settle();
    // A turn cut by a restart: begun, held by no process. It ends with a line, never asked again.
    const cut = spoken();
    ids.push(cut);
    d.s.desk.db.run(
      "insert into thread_entry (ask_key, asked_at, words, turn_id) values (?, ?, ?, 1)",
      [cut, new Date().toISOString(), "hey Life, cut"]
    );
    await d.receive();
    expect(d.entryOf(cut)?.error).toBe(CUT_BY_RESTART);
    for (const id of ids) {
      const e = d.entryOf(id);
      expect(e?.answered_at).toBeString();
      expect(e?.answer ?? e?.error).toBeString();
    }
    await d.receive();
    expect(readSpokenAsksCursor(d.s.desk.db).waiting).toEqual([]);
  } finally {
    pushes.mockRestore();
  }
});

test("words heard with low confidence reach the main session, but no act takes them", async () => {
  const d = deskOf();
  const pushes = spyOn(push, "notifyPhone").mockResolvedValue(true);
  try {
    const id = spoken("forget test Sam", "low");
    await d.receive();
    const ref = await d.toldMain(1);
    expect(d.s.fake.said.at(-1)?.message).toContain(
      "heard with low confidence"
    );
    const main = standingAgentOf(d.s.desk.db, "main")?.id ?? "";
    expect(
      await callDoorOf(d.s, main, "complain", { said: "forget test Sam" })
    ).toContain("must be his own words");
    d.s.fake.hear(ref, { kind: "words", text: "Did you say forget Sam?" });
    d.s.fake.exit(ref, true);
    await settle();
    expect(d.entryOf(id)?.answer).toBe("Did you say forget Sam?");
  } finally {
    pushes.mockRestore();
  }
});

// life#1103: his words told to an agent that then ended waited for good; they go to the Personal agent.
test("his words told to one agent go there; its agent ended, to the Personal agent", async () => {
  const d = deskOf();
  d.s.desk.runtimes.claude = d.s.fake.runtime;
  setSettings({ desk: { defaultRuntime: "claude", runtimes: {} } });
  const events = () =>
    d.s.desk.db
      .query<{ assignment_id: string; event_id: string; payload: string }, []>(
        `select assignment_id, event_id, payload from event where name = '${ASK_SPOKEN}' order by rowid`
      )
      .all()
      .map((e) => [e.assignment_id, e.event_id, JSON.parse(e.payload).by]);
  const to = asgOf(d.s.desk, await d.s.waiting());
  const told = (quote: string) =>
    ask(
      { at: new Date().toISOString(), quote, ref: `tell-life:${quote}` },
      { agent: DESK_AGENT, to },
      "connector",
      "his words through Tell Life to one agent"
    ).id;
  const kept = told("book the test dentist");
  await d.receive();
  expect(events()).toEqual([[to, kept, { to, why: "told" }]]);
  // Its agent ends: the unhanded ask is given back, and both it and a later one go to Personal.
  closeAssignmentRow(d.s.desk.db, to, { outcome: "done" });
  const late = told("move the test appointment");
  await d.receive();
  const personal = asgOf(
    d.s.desk,
    standingAgentOf(d.s.desk.db, "personal")?.id ?? ""
  );
  expect(events()).toEqual([
    [personal, kept, { to, why: "told" }],
    [personal, late, { to, why: "told" }],
  ]);
  expect(readSpokenAsksCursor(d.s.desk.db).waiting).toEqual([]);
  // No thread entry: the main session wrote his.
  expect(d.entryOf(kept)).toBeNull();
});
