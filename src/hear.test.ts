import { expect, test } from "bun:test";
import { asksIn, hear, speechIn, type Turn, wakes, whose } from "./hear";
import {
  turn as fed,
  lifelogServer,
  lifelogStore,
  page,
} from "./sources/fixtures";
import { apply } from "./sources/lifelog";

test("only the two words “hey Atlas”, in order, wake it, whatever the case and punctuation", () => {
  for (const said of [
    "hey Atlas, book a table",
    "Hey, Atlas.",
    "HEY ATLAS",
    "so... hey — atlas, remind me",
    "and then hey atlas",
  ]) {
    expect(wakes(said)).toBe(true);
  }
  for (const said of [
    "ok Atlas, book a table",
    "Atlas, book a table",
    "we use Stripe Atlas",
    "they atlas",
    "hey there Atlas",
    "Atlas hey",
    "hey atlases",
  ]) {
    expect(wakes(said)).toBe(false);
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

test("speech is complete once its last turn is someone else's or ends a recording closed on silence (under a minute of speech); a turn with no speaker waits for one", () => {
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
  expect(state(90, [his, other])).toBe("complete");
  expect(state(8, [his, nobody])).toBe("unnamed");
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
