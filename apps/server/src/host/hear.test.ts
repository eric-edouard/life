import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DESK_AGENT } from "../core/names";
import { LEDGER, tasksOf } from "../memory/memory-files";
import {
  conversation,
  turnFixture as fed,
  pageFixture,
  voiceServer,
  voiceStore,
} from "../sources/store-fixtures";
import { apply, readConversations, whose } from "../sources/voice-server";
import { hear, spansIn, speechIn, type Turn, wakes } from "./hear";

test('"hey Life" wakes Life as lifelog writes it (audit of 21 Oct), never an idiom', () => {
  for (const said of [
    "Hey Life, remind me",
    "Uh, hey, Life.",
    "Hey, life log, let's",
    "Hey, Live. I don't know",
    "hej life",
  ]) {
    expect(wakes().wake.test(said)).toBe(true);
  }
  for (const said of [
    "Get a life",
    "What a life",
    "Life is long",
    "hey lifelong friend",
    "they live here",
  ]) {
    expect(wakes().wake.test(said)).toBe(false);
  }
});

const AT = Date.parse("2026-10-19T10:00:00.000Z");
const iso = (s: number) => new Date(AT + s * 1000).toISOString();
/** A turn spoken at `s` s, lasting `long` s, brought by the feed 60 s after it started. */
const turn = (s: number, who: Turn["who"], text: string, long = 0): Turn => ({
  at: iso(s),
  end: iso(s + long),
  ref: `job:${s}@x`,
  seen: iso(s + 60),
  text,
  who,
});

test("a turn is his, someone else's when lifelog named anyone (by id or name), else nobody's", () => {
  const t = { at: "", end: null, jobId: "j", seen: null, turnIndex: 0 };
  expect(whose({ ...t, name: "Me", owner: true, personId: "p0" })).toBe("me");
  expect(whose({ ...t, name: "Ana", owner: false, personId: null })).toBe(
    "other"
  );
  expect(whose({ ...t, name: null, owner: false, personId: "p1" })).toBe(
    "other"
  );
  expect(whose({ ...t, name: null, owner: false, personId: null })).toBe(
    "unknown"
  );
});

test("his wake is high confidence, an unattributed one low, someone else's is no ask", () => {
  const asks = spansIn(
    [
      turn(0, "me", "hey Life, call the bank"),
      turn(60, "unknown", "hey Life, water the plant"),
      turn(120, "other", "hey Life, buy me a car"),
    ],
    ""
  );
  expect(asks.map((a) => [a.quote, a.confidence])).toEqual([
    ["hey Life, call the bank", "high"],
    ["hey Life, water the plant", "low"],
  ]);
  expect(asks[0]).toMatchObject({
    at: new Date(AT).toISOString(),
    ref: "job:0@x",
    turns: [0],
  });
});

// audit-4-hej-agent: the voice server wrote his "hey Life" as "Hej Life" (no speaker) and "Hey, live": no ask was made.
test("“Hej Life” from an unattributed voice is a low ask, from a named other none; “hey, live” is his low ask only", () => {
  const asks = spansIn(
    [
      turn(0, "unknown", "Hej Life test."),
      turn(60, "other", "Hej Life, buy me a car"),
      turn(120, "me", "Hé Life, rappelle-moi"),
      turn(180, "me", "Hey, live remind me to call"),
      turn(240, "unknown", "hey, live you're here"),
    ],
    ""
  );
  expect(asks.map((a) => [a.quote, a.confidence])).toEqual([
    ["Hej Life test.", "low"],
    ["Hé Life, rappelle-moi", "high"],
    ["Hey, live remind me to call", "low"],
  ]);
});

test("his own “hey Live” is lifelog mishearing “hey Life”: a low ask, never someone else's, an unattributed one or a plain Live", () => {
  const asks = spansIn(
    [
      turn(0, "me", "Hey Live, add milk to the list"),
      turn(60, "me", "Live, can you pass me the salt?"),
      turn(65, "other", "hey Live, sure"),
      turn(70, "me", "thanks Live, live we eat"),
      turn(130, "unknown", "hey Live, call me back"),
      turn(190, "me", "hey Life, book a table"),
      turn(195, "me", "hey Live, and a taxi"),
      turn(260, "me", "hey Live, hey Life, book it"),
      turn(320, "unknown", "hey Live, hey Life, book it"),
    ],
    ""
  );
  expect(asks.map((a) => [a.turns, a.confidence])).toEqual([
    [[0], "low"],
    [[5], "high"],
    [[6], "low"],
    [[7], "high"],
    [[8], "low"],
  ]);
});

test("an ask runs over his following turns until another speaker, a 15 s pause or a new wake", () => {
  const turns = [
    turn(0, "other", "what should we do?"),
    turn(5, "me", "Hey, Life."),
    turn(10, "me", "find a flight to Oslo"),
    turn(25, "me", "for Friday"),
    turn(30, "other", "and a hotel"),
    turn(35, "me", "not this one"),
    turn(100, "me", "hey life, remind me"),
    turn(110, "me", "to call mum"),
    turn(126, "me", "too late for the ask"),
    turn(130, "me", "hey Life, one more"),
    turn(135, "unknown", "an unattributed turn ends his ask"),
  ];
  expect(spansIn(turns, "").map((a) => [a.turns, a.quote])).toEqual([
    [[1, 2, 3], "Hey, Life. find a flight to Oslo for Friday"],
    [[6, 7], "hey life, remind me to call mum"],
    [[9], "hey Life, one more"],
  ]);
  // Only wakes at or after the hearing's start: earlier ones were heard before.
  expect(
    spansIn(turns, "2026-10-19T10:01:40.000Z").map((a) => a.turns[0])
  ).toEqual([6, 9]);
});

test("the pause is measured from a turn's end; the ask keeps when its last turn ended and when all of it arrived", () => {
  const [ask] = spansIn(
    [
      turn(0, "me", "hey Life, plan the week:", 30),
      turn(40, "me", "Monday is the dentist", 3),
      turn(70, "me", "after a long pause"),
    ],
    ""
  );
  expect(ask?.turns).toEqual([0, 1]);
  expect(ask?.timing).toEqual({ arrived: iso(100), ended: iso(43) });
});

test("speech is complete once its last turn is someone else's, ends a recording nobody spoke after, or lifelog settled the conversation", () => {
  const store = voiceStore();
  const at = "2026-10-19T10:00:00.000Z";
  const state = (
    silence: boolean | null,
    turns: ReturnType<typeof fed>[],
    closed = false
  ) => {
    store.db.run("delete from turns");
    store.db.run("delete from transcription_jobs");
    store.db.run("delete from conversations");
    apply(
      store,
      pageFixture({
        conversations: [conversation("c1", { closed })],
        jobs: [{ endedOnSilence: silence, id: "job-1" }],
        turns,
      })
    );
    return speechIn(store, "c1", at);
  };
  const his = fed(0, at, "p-me", "Me", "c1", true);
  const other = fed(1, "2026-10-19T10:00:09.000Z", "p-ana", "Ana");
  const nobody = fed(1, "2026-10-19T10:00:09.000Z", null, null);
  expect(state(true, [his])).toBe("complete");
  expect(state(false, [his])).toBe("open");
  // The voice server could not tell (an older recording): unknown, so wait.
  expect(state(null, [his])).toBe("open");
  // Settled: nothing more will join it.
  expect(state(false, [his], true)).toBe("complete");
  expect(state(false, [his, other])).toBe("complete");
  // A turn with no speaker yet is no reason to wait: only an ask's own wake is (`hear`).
  expect(state(true, [his, nobody])).toBe("complete");
});

test("a wake with no speaker waits up to 40 s for lifelog to name him, and holds back only itself (his misheard one waits for nothing)", async () => {
  const server = voiceServer({
    "/transcription-jobs/job-1/transcript": () => ({
      turns: [
        { speakerId: null, text: "hey Life, water the plant" },
        { speakerId: null, text: "hey Live, call the bank" },
      ],
    }),
  });
  const store = voiceStore();
  apply(
    store,
    pageFixture({
      turns: [
        fed(0, "2026-10-19T10:00:00.000Z", null, null),
        fed(1, "2026-10-19T10:00:20.000Z", "p-me", "Me", "c1", true),
      ],
    }),
    "2026-10-19T10:00:30.000Z"
  );
  const quotes = () => tasksOf().map((t) => t.ask.instruction.quote);
  try {
    expect(
      (await hear(store, "c1", "", Date.parse("2026-10-19T10:01:09Z"))).heard
    ).toBe(false);
    expect(quotes()).toEqual(["hey Live, call the bank"]);
    expect(
      (await hear(store, "c1", "", Date.parse("2026-10-19T10:01:11Z"))).heard
    ).toBe(true);
    expect(quotes()).toEqual([
      "hey Live, call the bank",
      "hey Life, water the plant",
    ]);
  } finally {
    server.close();
    rmSync(LEDGER, { force: true });
  }
});

test("his misheard wake with no speaker yet waits for lifelog to name him", async () => {
  const server = voiceServer({
    "/transcription-jobs/job-1/transcript": () => ({
      turns: [{ speakerId: null, text: "hey Live, buy milk" }],
    }),
  });
  const store = voiceStore();
  const at = "2026-10-19T10:00:00.000Z";
  apply(
    store,
    pageFixture({ turns: [fed(0, at, null, null)] }),
    "2026-10-19T10:00:30.000Z"
  );
  const quotes = () => tasksOf().map((t) => t.ask.instruction.quote);
  try {
    expect(
      (await hear(store, "c1", "", Date.parse("2026-10-19T10:00:50Z"))).heard
    ).toBe(false);
    expect(quotes()).toEqual([]);
    apply(
      store,
      pageFixture({ turns: [fed(0, at, "p-me", "Me", "c1", true)] }),
      "2026-10-19T10:00:55.000Z"
    );
    expect(
      (await hear(store, "c1", "", Date.parse("2026-10-19T10:01:00Z"))).heard
    ).toBe(true);
    expect(quotes()).toEqual(["hey Live, buy milk"]);
  } finally {
    server.close();
    rmSync(LEDGER, { force: true });
  }
});

test("a failed word fetch throws, so the watcher hears it again: never read as silence", async () => {
  const server = voiceServer({});
  const store = voiceStore();
  apply(
    store,
    pageFixture({
      turns: [fed(0, "2026-10-19T10:00:00.000Z", null, null, "c1", true)],
    })
  );
  await expect(hear(store, "c1", "")).rejects.toThrow("404");
  server.close();
});

test("his ask heard in a conversation is also marked, its whole span; heard again from later, the earlier mark stays", async () => {
  const server = voiceServer({
    "/transcription-jobs/job-1/transcript": () => ({
      turns: [
        { speakerId: null, text: "hey Life, the stones are for Nina" },
        { speakerId: null, text: "and the vote is Sunday" },
        { speakerId: null, text: "ok" },
      ],
    }),
  });
  const store = voiceStore();
  apply(
    store,
    pageFixture({
      conversations: [conversation("c1")],
      turns: [
        fed(0, "2026-10-19T10:00:00.000Z", "p-me", "Me", "c1", true),
        fed(1, "2026-10-19T10:00:05.000Z", "p-me", "Me", "c1", true),
        fed(2, "2026-10-19T10:00:10.000Z", "p-ana", "Ana"),
      ],
    }),
    "2026-10-19T10:00:30.000Z"
  );
  const marked = () =>
    readConversations(store, new Date("2026-10-01"))[0]?.turns[0]?.marks;
  try {
    expect(
      (await hear(store, "c1", "", Date.parse("2026-10-19T10:05:00Z"))).marked
    ).toBe(true);
    expect(marked()).toEqual([
      "job-1:0@2026-10-19T10:00:00.000Z",
      "job-1:1@2026-10-19T10:00:05.000Z",
    ]);
    await hear(
      store,
      "c1",
      "2026-10-19T10:00:10.000Z",
      Date.parse("2026-10-19T10:06:00Z")
    );
    expect(marked()).toHaveLength(2);
    // The same span is his one ask.
    expect(tasksOf().map((t) => t.ask.instruction.quote)).toEqual([
      "hey Life, the stones are for Nina and the vote is Sunday",
    ]);
  } finally {
    server.close();
    rmSync(LEDGER, { force: true });
  }
});

test('"hey Life" heard is one ask of the desk, from the conversation it was said in', async () => {
  const server = voiceServer({
    "/transcription-jobs/job-1/transcript": () => ({
      turns: [{ speakerId: null, text: "hey Life, book the test dentist" }],
    }),
  });
  const store = voiceStore();
  apply(
    store,
    pageFixture({
      conversations: [conversation("c1")],
      turns: [fed(0, "2026-10-19T10:00:00.000Z", "p-me", "Me", "c1", true)],
    }),
    "2026-10-19T10:00:30.000Z"
  );
  try {
    await hear(store, "c1", "", Date.parse("2026-10-19T10:05:00Z"));
    expect(
      tasksOf().map((t) => [t.ask.after.agent, t.ask.after.conversation])
    ).toEqual([[DESK_AGENT, "c1"]]);
  } finally {
    server.close();
    rmSync(LEDGER, { force: true });
  }
});
