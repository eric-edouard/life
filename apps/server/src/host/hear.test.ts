import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { LEDGER, tasksOf } from "../memory/ledger";
import { MARK, WAKE } from "../memory/tasks";
import { apply, readConversations, whose } from "../sources/lifelog";
import {
  chapter,
  conversation,
  turnFixture as fed,
  lifelogServer,
  lifelogStore,
  pageFixture,
} from "../sources/store-fixtures";
import { asksIn, hear, marksIn, speechIn, type Turn } from "./hear";

test("only “hey Orbit” or its misheard word, in order, wake it, whatever the case and punctuation", () => {
  for (const said of [
    "hey Orbit, book a table",
    "Hey, Orbit.",
    "HEY ORBIT",
    "so... hey — orbit, remind me",
    "and then hey orbit",
    "hey, zorba: call",
    "Hej Orbit test.",
    "hei orbit",
    "Hey, or bit remind me",
    "Hé Orbit, rappelle-moi",
    "ey Orbit",
  ]) {
    expect(WAKE.test(said)).toBe(true);
  }
  for (const said of [
    "ok Orbit, book a table",
    "Orbit, book a table",
    "we use Stripe Orbit",
    "they orbit",
    "hey there Orbit",
    "Orbit hey",
    "hey orbites",
    "hey zorbas",
    "envoie-le à Orbit",
    "a Orbit",
    "Orbit is okay.",
    "they Orbit",
    "okey Orbit",
    "the Orbit",
    "hay Orbit",
    "ok, or bit",
  ]) {
    expect(WAKE.test(said)).toBe(false);
  }
});

test('"hey Life" as lifelog writes it (audit of 21 Oct), never an idiom', () => {
  for (const said of [
    "Hey Life, remind me",
    "Uh, hey, Life.",
    "Hey, life log, let's",
    "Hey, Live. I don't know",
    "hej life",
  ]) {
    expect(MARK.test(said)).toBe(true);
  }
  for (const said of [
    "Get a life",
    "What a life",
    "Life is long",
    "hey lifelong friend",
    "they live here",
  ]) {
    expect(MARK.test(said)).toBe(false);
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
  const asks = asksIn(
    [
      turn(0, "me", "hey Orbit, call the bank"),
      turn(60, "unknown", "hey Orbit, water the plant"),
      turn(120, "other", "hey Orbit, buy me a car"),
    ],
    ""
  );
  expect(asks.map((a) => [a.quote, a.confidence])).toEqual([
    ["hey Orbit, call the bank", "high"],
    ["hey Orbit, water the plant", "low"],
  ]);
  expect(asks[0]).toMatchObject({
    at: new Date(AT).toISOString(),
    ref: "job:0@x",
    turns: [0],
  });
});

// audit-4-hej-agent: lifelog wrote his "hey Orbit" as "Hej Orbit" (no speaker) and "Hey, or bit": no ask was made.
test("“Hej Orbit” from an unattributed voice is a low ask, from a named other none; “hey, or bit” is his low ask only", () => {
  const asks = asksIn(
    [
      turn(0, "unknown", "Hej Orbit test."),
      turn(60, "other", "Hej Orbit, buy me a car"),
      turn(120, "me", "Hé Orbit, rappelle-moi"),
      turn(180, "me", "Hey, or bit remind me to call"),
      turn(240, "unknown", "hey, or bit you're here"),
    ],
    ""
  );
  expect(asks.map((a) => [a.quote, a.confidence])).toEqual([
    ["Hej Orbit test.", "low"],
    ["Hé Orbit, rappelle-moi", "high"],
    ["Hey, or bit remind me to call", "low"],
  ]);
});

test("his own “hey Zorba” (the misheard setting) is lifelog mishearing “hey Orbit”: a low ask, never someone else's, an unattributed one or a plain Zorba", () => {
  const asks = asksIn(
    [
      turn(0, "me", "Hey Zorba, add milk to the list"),
      turn(60, "me", "Zorba, can you pass me the salt?"),
      turn(65, "other", "hey Zorba, sure"),
      turn(70, "me", "thanks Zorba, or bit we eat"),
      turn(130, "unknown", "hey Zorba, call me back"),
      turn(190, "me", "hey Orbit, book a table"),
      turn(195, "me", "hey Zorba, and a taxi"),
      turn(260, "me", "hey Zorba, hey Orbit, book it"),
      turn(320, "unknown", "hey Zorba, hey Orbit, book it"),
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
    turn(5, "me", "Hey, Orbit."),
    turn(10, "me", "find a flight to Oslo"),
    turn(25, "me", "for Friday"),
    turn(30, "other", "and a hotel"),
    turn(35, "me", "not this one"),
    turn(100, "me", "hey orbit, remind me"),
    turn(110, "me", "to call mum"),
    turn(126, "me", "too late for the ask"),
    turn(130, "me", "hey Orbit, one more"),
    turn(135, "unknown", "an unattributed turn ends his ask"),
  ];
  expect(asksIn(turns, "").map((a) => [a.turns, a.quote])).toEqual([
    [[1, 2, 3], "Hey, Orbit. find a flight to Oslo for Friday"],
    [[6, 7], "hey orbit, remind me to call mum"],
    [[9], "hey Orbit, one more"],
  ]);
  // Only wakes at or after the hearing's start: earlier ones were heard before.
  expect(
    asksIn(turns, "2026-10-19T10:01:40.000Z").map((a) => a.turns[0])
  ).toEqual([6, 9]);
});

test("the pause is measured from a turn's end; the ask keeps when its last turn ended and when all of it arrived", () => {
  const [ask] = asksIn(
    [
      turn(0, "me", "hey Orbit, plan the week:", 30),
      turn(40, "me", "Monday is the dentist", 3),
      turn(70, "me", "after a long pause"),
    ],
    ""
  );
  expect(ask?.turns).toEqual([0, 1]);
  expect(ask?.timing).toEqual({ arrived: iso(100), ended: iso(43) });
});

test("speech is complete once its last turn is someone else's or ends a recording closed on silence (under a minute of speech)", () => {
  const store = lifelogStore();
  const at = "2026-10-19T10:00:00.000Z";
  const state = (seconds: number | null, turns: ReturnType<typeof fed>[]) => {
    store.db.run("delete from turns");
    store.db.run("delete from jobs");
    apply(
      store,
      pageFixture({
        jobs:
          seconds === null ? [] : [{ durationSeconds: seconds, id: "job-1" }],
        turns,
      })
    );
    return speechIn(store, "c1", at);
  };
  const his = fed(0, at, "p-me", "Me", "c1", true);
  const other = fed(1, "2026-10-19T10:00:09.000Z", "p-ana", "Ana");
  const nobody = fed(1, "2026-10-19T10:00:09.000Z", null, null);
  expect(state(8, [his])).toBe("complete");
  expect(state(90, [his])).toBe("open");
  expect(state(null, [his])).toBe("open");
  expect(state(0, [his])).toBe("open");
  expect(state(90, [his, other])).toBe("complete");
  // A turn with no speaker yet is no reason to wait: only an ask's own wake is (`hear`).
  expect(state(8, [his, nobody])).toBe("complete");
});

test("a wake with no speaker waits up to 40 s for lifelog to name him, and holds back only itself (his misheard one waits for nothing)", async () => {
  const server = lifelogServer({
    "/transcription-jobs/job-1/transcript": () => ({
      turns: [
        { speakerId: null, text: "hey Orbit, water the plant" },
        { speakerId: null, text: "hey Zorba, call the bank" },
      ],
    }),
  });
  const store = lifelogStore();
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
    expect(quotes()).toEqual(["hey Zorba, call the bank"]);
    expect(
      (await hear(store, "c1", "", Date.parse("2026-10-19T10:01:11Z"))).heard
    ).toBe(true);
    expect(quotes()).toEqual([
      "hey Zorba, call the bank",
      "hey Orbit, water the plant",
    ]);
  } finally {
    server.close();
    rmSync(LEDGER, { force: true });
  }
});

test("his misheard wake with no speaker yet waits for lifelog to name him", async () => {
  const server = lifelogServer({
    "/transcription-jobs/job-1/transcript": () => ({
      turns: [{ speakerId: null, text: "hey Zorba, buy milk" }],
    }),
  });
  const store = lifelogStore();
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
    expect(quotes()).toEqual(["hey Zorba, buy milk"]);
  } finally {
    server.close();
    rmSync(LEDGER, { force: true });
  }
});

test("a failed word fetch throws, so the watcher hears it again: never read as silence", async () => {
  const server = lifelogServer({});
  const store = lifelogStore();
  apply(
    store,
    pageFixture({
      turns: [fed(0, "2026-10-19T10:00:00.000Z", null, null, "c1", true)],
    })
  );
  await expect(hear(store, "c1", "")).rejects.toThrow("404");
  server.close();
});

test('a "hey Life" span is his (high) or unattributed (low), never someone else\'s, and runs like an ask', () => {
  const turns = [
    turn(0, "other", "hey Life, you got me"),
    turn(10, "me", "Hey life, I committed to two things.", 3),
    turn(15, "me", "To vote for the stones.", 2),
    turn(18, "other", "Nice."),
    turn(30, "unknown", "hey Life, log this"),
  ];
  expect(marksIn(turns, "").map((m) => [m.confidence, m.turns])).toEqual([
    ["high", [1, 2]],
    ["low", [4]],
  ]);
  // A "hey Life" is never an ask, and a "hey Orbit" never a mark.
  expect(asksIn(turns, "")).toEqual([]);
  expect(marksIn([turn(0, "me", "hey Orbit, book it")], "")).toEqual([]);
});

test('his "hey Life" heard in a conversation marks its chapter; heard again from later, the earlier mark stays', async () => {
  const server = lifelogServer({
    "/transcription-jobs/job-1/transcript": () => ({
      turns: [
        { speakerId: null, text: "hey Life, the stones are for Nina" },
        { speakerId: null, text: "and the vote is Sunday" },
        { speakerId: null, text: "ok" },
      ],
    }),
  });
  const store = lifelogStore();
  apply(
    store,
    pageFixture({
      chapters: [
        chapter("a", "2026-10-19T09:00:00.000Z", "2026-10-19T11:00:00.000Z"),
      ],
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
    readConversations(store, new Date("2026-10-01"))[0]?.chapters[0]?.marked;
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
    // A "hey Life" is never an ask.
    expect(tasksOf()).toEqual([]);
  } finally {
    server.close();
    rmSync(LEDGER, { force: true });
  }
});
