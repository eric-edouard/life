import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { asksIn, hear, speechIn, type Turn, WAKE, whose } from "./hear";
import { ACTIONS } from "./memory/ledger";
import {
  turn as fed,
  lifelogServer,
  lifelogStore,
  page,
} from "./sources/fixtures";
import { apply } from "./sources/lifelog";
import { tasksOf } from "./tasks";

test("only “hey Atlas” or its misheard word, in order, wake it, whatever the case and punctuation", () => {
  for (const said of [
    "hey Atlas, book a table",
    "Hey, Atlas.",
    "HEY ATLAS",
    "so... hey — atlas, remind me",
    "and then hey atlas",
    "hey, zorba: call",
    "Hej Atlas test.",
    "hei atlas",
    "Hey, at last remind me",
    "Hé Atlas, rappelle-moi",
    "ey Atlas",
  ]) {
    expect(WAKE.test(said)).toBe(true);
  }
  for (const said of [
    "ok Atlas, book a table",
    "Atlas, book a table",
    "we use Stripe Atlas",
    "they atlas",
    "hey there Atlas",
    "Atlas hey",
    "hey atlases",
    "hey zorbas",
    "envoie-le à Atlas",
    "a Atlas",
    "Atlas is okay.",
    "they Atlas",
    "okey Atlas",
    "the Atlas",
    "hay Atlas",
    "ok, at last",
  ]) {
    expect(WAKE.test(said)).toBe(false);
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
      turn(0, "me", "hey Atlas, call the bank"),
      turn(60, "unknown", "hey Atlas, water the plant"),
      turn(120, "other", "hey Atlas, buy me a car"),
    ],
    ""
  );
  expect(asks.map((a) => [a.quote, a.confidence])).toEqual([
    ["hey Atlas, call the bank", "high"],
    ["hey Atlas, water the plant", "low"],
  ]);
  expect(asks[0]).toMatchObject({
    at: new Date(AT).toISOString(),
    ref: "job:0@x",
    turns: [0],
  });
});

// audit-4-hej-atlas: lifelog wrote his "hey Atlas" as "Hej Atlas" (no speaker) and "Hey, at last": no ask was made.
test("“Hej Atlas” from an unattributed voice is a low ask, from a named other none; “hey, at last” is his low ask only", () => {
  const asks = asksIn(
    [
      turn(0, "unknown", "Hej Atlas test."),
      turn(60, "other", "Hej Atlas, buy me a car"),
      turn(120, "me", "Hé Atlas, rappelle-moi"),
      turn(180, "me", "Hey, at last remind me to call"),
      turn(240, "unknown", "hey, at last you're here"),
    ],
    ""
  );
  expect(asks.map((a) => [a.quote, a.confidence])).toEqual([
    ["Hej Atlas test.", "low"],
    ["Hé Atlas, rappelle-moi", "high"],
    ["Hey, at last remind me to call", "low"],
  ]);
});

test("his own “hey Zorba” (LIFE_MISHEARD) is lifelog mishearing “hey Atlas”: a low ask, never someone else's, an unattributed one or a plain Zorba", () => {
  const asks = asksIn(
    [
      turn(0, "me", "Hey Zorba, add milk to the list"),
      turn(60, "me", "Zorba, can you pass me the salt?"),
      turn(65, "other", "hey Zorba, sure"),
      turn(70, "me", "thanks Zorba, at last we eat"),
      turn(130, "unknown", "hey Zorba, call me back"),
      turn(190, "me", "hey Atlas, book a table"),
      turn(195, "me", "hey Zorba, and a taxi"),
      turn(260, "me", "hey Zorba, hey Atlas, book it"),
      turn(320, "unknown", "hey Zorba, hey Atlas, book it"),
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
    turn(5, "me", "Hey, Atlas."),
    turn(10, "me", "find a flight to Oslo"),
    turn(25, "me", "for Friday"),
    turn(30, "other", "and a hotel"),
    turn(35, "me", "not this one"),
    turn(100, "me", "hey atlas, remind me"),
    turn(110, "me", "to call mum"),
    turn(126, "me", "too late for the ask"),
    turn(130, "me", "hey Atlas, one more"),
    turn(135, "unknown", "an unattributed turn ends his ask"),
  ];
  expect(asksIn(turns, "").map((a) => [a.turns, a.quote])).toEqual([
    [[1, 2, 3], "Hey, Atlas. find a flight to Oslo for Friday"],
    [[6, 7], "hey atlas, remind me to call mum"],
    [[9], "hey Atlas, one more"],
  ]);
  // Only wakes at or after the hearing's start: earlier ones were heard before.
  expect(
    asksIn(turns, "2026-10-19T10:01:40.000Z").map((a) => a.turns[0])
  ).toEqual([6, 9]);
});

test("the pause is measured from a turn's end; the ask keeps when its last turn ended and when all of it arrived", () => {
  const [ask] = asksIn(
    [
      turn(0, "me", "hey Atlas, plan the week:", 30),
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
      page({
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
        { speakerId: null, text: "hey Atlas, water the plant" },
        { speakerId: null, text: "hey Zorba, call the bank" },
      ],
    }),
  });
  const store = lifelogStore();
  apply(
    store,
    page({
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
      await hear(store, "c1", "", Date.parse("2026-10-19T10:01:09Z"))
    ).toBe(false);
    expect(quotes()).toEqual(["hey Zorba, call the bank"]);
    expect(
      await hear(store, "c1", "", Date.parse("2026-10-19T10:01:11Z"))
    ).toBe(true);
    expect(quotes()).toEqual([
      "hey Zorba, call the bank",
      "hey Atlas, water the plant",
    ]);
  } finally {
    server.close();
    rmSync(ACTIONS, { force: true });
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
    page({ turns: [fed(0, at, null, null)] }),
    "2026-10-19T10:00:30.000Z"
  );
  const quotes = () => tasksOf().map((t) => t.ask.instruction.quote);
  try {
    expect(
      await hear(store, "c1", "", Date.parse("2026-10-19T10:00:50Z"))
    ).toBe(false);
    expect(quotes()).toEqual([]);
    apply(
      store,
      page({ turns: [fed(0, at, "p-me", "Me", "c1", true)] }),
      "2026-10-19T10:00:55.000Z"
    );
    expect(
      await hear(store, "c1", "", Date.parse("2026-10-19T10:01:00Z"))
    ).toBe(true);
    expect(quotes()).toEqual(["hey Zorba, buy milk"]);
  } finally {
    server.close();
    rmSync(ACTIONS, { force: true });
  }
});

test("a failed word fetch throws, so the watcher hears it again: never read as silence", async () => {
  const server = lifelogServer({});
  const store = lifelogStore();
  apply(
    store,
    page({
      turns: [fed(0, "2026-10-19T10:00:00.000Z", null, null, "c1", true)],
    })
  );
  await expect(hear(store, "c1", "")).rejects.toThrow("404");
  server.close();
});
