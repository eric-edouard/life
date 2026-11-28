import { expect, setSystemTime, test } from "bun:test";
import { rmSync } from "node:fs";
import { clock, daysBefore, HOUR, MIN } from "../core/clock";
import {
  conversation as feedConversation,
  pageFixture,
  turnFixture,
  voiceServer,
} from "../sources/store-fixtures";
import { apply, openStore, WATCH } from "../sources/voice-server";
import { CONFIRMS_A_DAY, readRecentVoice } from "./arrival-reader";
import {
  ASK,
  ago,
  mail,
  msg,
  sceneOf,
  voiceOf,
  yes,
} from "./arrival-reader-scene";
import { readConfirmedArrivals } from "./read-replies";
import { OWNER, type Truth } from "./read-truth";
import { dayNow, dayStart } from "./zones";

// Voice: closed conversations he spoke in, read as they arrive.
test("voice: an open conversation waits, one he did not speak in is skipped, a closed one is read once", async () => {
  const s = sceneOf(() => yes("bring the plans"));
  await s.read(
    [],
    true,
    0,
    voiceOf("open", { closed: false, spoke: true, turns: 4 })
  );
  await s.read(
    [],
    true,
    0,
    voiceOf("heard", { closed: true, spoke: false, turns: 4 })
  );
  expect(s.calls).toEqual({ apple: 0, engine: 0 });
  const closed = voiceOf("talk", { closed: true, spoke: true, turns: 4 });
  await s.read([], true, 0, closed);
  await s.read([], true, 0, closed);
  expect(s.calls).toEqual({ apple: 0, engine: 1 });
  expect(readConfirmedArrivals(ago(60), s.where)).toEqual([
    expect.objectContaining({ people: ["person:sam"] }),
  ]);
});

test("voice: a closed long conversation is read whole, every chunk in one pass", async () => {
  const s = sceneOf(() => yes("bring the plans"));
  const long = voiceOf("long", {
    chars: 1000,
    closed: true,
    spoke: true,
    turns: 12,
  });
  await s.read([], true, 0, long);
  expect(s.calls).toEqual({ apple: 0, engine: 3 });
  expect(
    s
      .lines()
      .filter((l) => l.read === "arrival_confirm")
      .flatMap((l) => l.messages)
      .toSorted()
  ).toEqual(
    [...long.spoken.values()]
      .flat()
      .map((l) => `voice|${l.ref}`)
      .toSorted()
  );
});

/** Minutes before now of `days` local days back's start, plus `plus` minutes (negative: later than now). */
const minutesAgoOf = (days: number, plus: number) =>
  (clock().getTime() - dayStart(daysBefore(dayNow(), days)).getTime()) / MIN -
  plus;

test("voice: a conversation across midnight he spoke in before it is read after it too", async () => {
  const s = sceneOf(() => yes("bring the plans"));
  const before = voiceOf("night", {
    closed: true,
    minutesAgo: minutesAgoOf(0, -10),
    spoke: true,
    turns: 2,
  });
  const after = voiceOf("night", {
    closed: true,
    minutesAgo: minutesAgoOf(0, 1),
    spoke: false,
    turns: 2,
  });
  await s.read([], true, 0, {
    built: [...before.built, ...after.built],
    closed: before.closed,
    spoken: new Map([...before.spoken, ...after.spoken]),
    turns: new Map([...before.turns, ...after.turns]),
  });
  expect(s.calls).toEqual({ apple: 0, engine: 2 });
});

test("voice: a day before yesterday's is the night's, never read", async () => {
  const s = sceneOf(() => yes("bring the plans"));
  await s.read(
    [],
    true,
    0,
    voiceOf("old", {
      closed: true,
      minutesAgo: minutesAgoOf(2, 10),
      spoke: true,
      turns: 2,
    })
  );
  expect(s.calls).toEqual({ apple: 0, engine: 0 });
});

test("voice: an offline read of a conversation that turns out not his asks his engine nothing later", async () => {
  const s = sceneOf(() => yes("bring the plans"));
  await s.read(
    [],
    false,
    0,
    voiceOf("t", { closed: true, spoke: true, turns: 2 })
  );
  // His only turn was someone else's after all (a speaker corrected).
  await s.read(
    [],
    true,
    0,
    voiceOf("t", { closed: true, spoke: false, turns: 2 })
  );
  expect(s.calls).toEqual({ apple: 0, engine: 0 });
});

test("voice: a conversation reopened or a speaker corrected within one pass is read as the store's one read saw it", async () => {
  // A made-up closed conversation in the watcher's store: his turn, then Sam's; the words from a fake voice server.
  const [first, last, late] = [ago(20), ago(12), ago(16)];
  const server = voiceServer({
    "/transcription-jobs/job-r/transcript": () => ({
      turns: ["I'll bring the plans", "Thanks", "And the keys?"].map(
        (text) => ({ speakerId: null, text })
      ),
    }),
  });
  const store = openStore();
  const feed = (closed: boolean, turns: ReturnType<typeof turnFixture>[]) =>
    apply(
      store,
      pageFixture({
        conversations: [
          feedConversation("talk-r", {
            closed,
            endAt: ago(10),
            startAt: first,
          }),
        ],
        turns: turns.map((t) => ({ ...t, jobId: "job-r" })),
      })
    );
  try {
    feed(true, [
      turnFixture(0, first, null, null, "talk-r", true),
      turnFixture(1, last, null, "Sam", "talk-r"),
    ]);
    // The truth the watcher passes, made up.
    const truth = { people: [] } as unknown as Truth;
    const voice = await readRecentVoice(dayNow(), truth);
    // Before the words are fetched: reopened, a turn added inside its span, and his turn given to Sam.
    feed(false, [
      turnFixture(0, first, null, "Sam", "talk-r"),
      turnFixture(2, late, null, "Sam", "talk-r"),
    ]);
    const s = sceneOf(() => yes(""));
    await s.read([], true, 0, voice);
    // His turn and Sam's, as that read saw them; the reopened conversation's new turn is a later pass's.
    expect(s.shown.join("\n").split("\n")).toEqual([
      expect.stringContaining(`${OWNER}: I'll bring the plans`),
      expect.stringContaining("Thanks"),
    ]);
  } finally {
    store.db.close();
    server.close();
    rmSync(WATCH, { force: true, recursive: true });
  }
});

test("voice: a conversation read whole fetches no words again", async () => {
  const s = sceneOf(() => yes("bring the plans"));
  const talk = voiceOf("again", { closed: true, spoke: true, turns: 2 });
  await s.read([], true, 0, talk);
  await s.read([], true, 0, talk);
  expect(s.fetched).toEqual([1, 0]);
});

test("voice: a chunk whose confirm failed is read again on the next pass, the others not", async () => {
  const s = sceneOf(() => yes("unused"), ASK, true);
  const thai = voiceOf("thai", {
    chars: 3000,
    closed: true,
    spoke: true,
    turns: 4,
  });
  for (const lines of thai.spoken.values()) {
    for (const l of lines) {
      l.text = `ช่วยเอาแผนมาด้วย ${l.text}`;
    }
  }
  // Four chunks, each to his engine's confirm, the first failing: the next pass asks that one again alone, and a
  // third fetches nothing.
  await s.read([], true, 0, thai);
  await s.read([], true, 0, thai);
  await s.read([], true, 0, thai);
  expect(s.calls.engine).toBe(5);
  expect(s.fetched).toEqual([1, 1, 0]);
});

test("a mail trigger left pending past midnight (the cap spent) is the night's, never confirmed the next day", async () => {
  const midnight = dayStart(dayNow()).getTime();
  setSystemTime(new Date(midnight - 30 * MIN));
  try {
    const s = sceneOf(() => yes("bring the plans"));
    const events = [mail("Can you bring the plans?")];
    await s.read(events, true, CONFIRMS_A_DAY);
    setSystemTime(new Date(midnight + 30 * MIN));
    await s.read(events, true, 0);
    expect(s.calls).toEqual({ apple: 1, engine: 0 });
  } finally {
    setSystemTime();
  }
});

test("voice: the voice server unreachable, chats and mail are still read", async () => {
  const s = sceneOf(() => yes("send the slides"));
  await s.read([msg("Can you send the slides?")], true, 0, {
    ...voiceOf("talk", { closed: true, spoke: true, turns: 2 }),
    fails: true,
  });
  expect(s.calls).toEqual({ apple: 0, engine: 1 });
});

test("voice: yesterday's first turns filed under last month are seen as read the next evening", async () => {
  // Its first turn just after yesterday began, which is last month in UTC wherever the day starts before UTC's.
  setSystemTime(new Date(dayStart("2026-11-02").getTime() + 20 * HOUR));
  try {
    const s = sceneOf(() => yes("bring the plans"));
    const start = dayStart(daysBefore(dayNow(), 1)).getTime() + 10 * MIN;
    const talk = voiceOf("early", {
      closed: true,
      minutesAgo: (clock().getTime() - start) / MIN,
      spoke: true,
      turns: 2,
    });
    await s.read([], true, 0, talk);
    await s.read([], true, 0, talk);
    expect(s.calls).toEqual({ apple: 0, engine: 1 });
  } finally {
    setSystemTime();
  }
});
