import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, daysBefore, HOUR, iso, MIN } from "../core/clock";
import { log } from "../core/log";
import type { FoundationAnswer } from "../models/foundation-model";
import { stamp } from "../models/llm";
import type { ReadReply } from "../records/read-reply";
import type { SourceEvent } from "../records/source";
import type { Unit } from "../records/unit";
import { apply, openStore, turnRef, WATCH } from "../sources/lifelog";
import {
  conversation as feedConversation,
  lifelogServer,
  pageFixture,
  turnFixture,
} from "../sources/store-fixtures";
import {
  CONFIRMS_A_DAY,
  type RecentVoice,
  readArrivals,
  readRecentVoice,
} from "./arrival-reader";
import type { SourceLine } from "./quote-check";
import { readConfirmedArrivals, readReplies, storeReply } from "./read-replies";
import { OWNER, type Truth } from "./read-truth";
import { voiceUnitId } from "./unit-ids";
import { applyRules, messageUnits } from "./units";
import { dayNow, dayStart, localDate } from "./zones";

// Made-up chats with Sam, someone he knows; Apple and his engine are fakes counting their calls.
const SAM = "33600000001@s.whatsapp.net";
const known = (h: string) => (h === SAM ? "person:sam" : null);
const ago = (minutes: number) =>
  new Date(clock().getTime() - minutes * MIN).toISOString();
let n = 0;
const msg = (text: string, over: Partial<SourceEvent> = {}): SourceEvent => {
  n += 1;
  return {
    at: ago(30 - n / 100),
    chat: SAM,
    fromMe: false,
    id: `whatsapp:${n}`,
    sender: SAM,
    source: "whatsapp",
    text,
    ...over,
  };
};
const people = { nameOf: (r: string) => r, resolve: known };

let dir = "";
let trial = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "arrival-reader-"));
});
afterAll(() => rm(dir, { force: true, recursive: true }));

/** A scene: its own replies folder, Apple answering `apple`, his engine answering `confirm`, both counted. */
const sceneOf = (
  apple: (text: string) => FoundationAnswer,
  confirm = true,
  /** His engine fails its first call. */
  failsFirst = false,
  /** His engine's answer to an appointment read, or a call that may fail. */
  meeting: object | (() => Promise<object>) = { agreed: false }
) => {
  trial += 1;
  const where = join(dir, `trial-${trial}`);
  const calls = { apple: 0, engine: 0 };
  const step = {
    ask: (q: { input: { firstDay?: string; lines: string[] } }) => {
      shown.push(q.input.lines.join("\n"));
      calls.engine += 1;
      if (failsFirst && calls.engine === 1) {
        return Promise.reject(new Error("engine down"));
      }
      if (!q.input.firstDay) {
        return Promise.resolve({ isActionable: confirm });
      }
      return typeof meeting === "function"
        ? meeting()
        : Promise.resolve(meeting);
    },
    attempt: (work: () => Promise<unknown>) => work().catch(() => undefined),
    dir: join(dir, "run"),
    end: (c: object) => c,
    keeps: () => false,
    llm: { engine: "codex", model: "test" },
    madeBy: (prompt: string) =>
      stamp({ engine: "codex", model: "test" }, prompt, "r1"),
    run: "r1",
  };
  const shown: string[] = [];
  /** How many voice units' words each pass fetched. */
  const fetched: number[] = [];
  /** `confirmsToday` null: counted from the model log, as in production. */
  const read = (
    events: SourceEvent[],
    isUp = true,
    confirmsToday: number | null = 0,
    voice?: Voice
  ) =>
    readArrivals(
      {
        built: applyRules(messageUnits(events, known)),
        fileEvents: [],
        ...(voice ? { voice } : {}),
      },
      people,
      ["Ozren"],
      {
        ...(voice
          ? {
              spoken: (turns: Map<string, unknown>) => {
                fetched.push(turns.size);
                return voice.fails
                  ? Promise.reject(new Error("lifelog unreachable"))
                  : Promise.resolve(voice.spoken);
              },
            }
          : {}),
        apple: (requests) => {
          calls.apple += requests.length;
          return Promise.resolve(requests.map((r) => apple(r.text)));
        },
        ...(confirmsToday === null
          ? {}
          : { confirmsToday: () => Promise.resolve(confirmsToday) }),
        online: () => Promise.resolve(isUp),
        step: () => Promise.resolve(step as never),
        where,
      }
    );
  const lines = () => readReplies(where).flat();
  return { calls, fetched, lines, read, shown, where };
};
/** Today's voice as the reader is given it, and the words its turns' fetch gives back. */
interface Voice extends RecentVoice {
  /** Fetching the turns' words fails (lifelog unreachable). */
  fails?: boolean;
  spoken: Map<string, SourceLine[]>;
}
/**
 * A made-up conversation with Sam: `turns` turns of `chars` characters, his own every other one when he spoke, the
 * first `minutesAgo` (default 20) minutes ago.
 */
const voiceOf = (
  conversation: string,
  o: {
    closed: boolean;
    chars?: number;
    minutesAgo?: number;
    spoke: boolean;
    turns: number;
  }
): Voice => {
  const lines = Array.from({ length: o.turns }, (_, i) => {
    const at = ago((o.minutesAgo ?? 20) - i / 10);
    return {
      at,
      ref: turnRef(conversation, i, at),
      speaker: o.spoke && i % 2 === 1 ? OWNER : "person:sam",
      text: `Can you bring the plans? ${"y".repeat(o.chars ?? 20)}`,
    };
  });
  const unit = {
    date: localDate(lines[0]?.at ?? ""),
    end: lines.at(-1)?.at,
    hash: "0123456789abcdef",
    id: voiceUnitId(conversation, localDate(lines[0]?.at ?? "")),
    key: conversation,
    people: o.spoke ? ["person:sam", OWNER] : ["person:sam"],
    refs: [lines[0]?.ref, lines.at(-1)?.ref],
    schemaVersion: 1,
    source: "lifelog",
    start: lines[0]?.at,
    stats: { chars: 0, fromMe: o.spoke ? 1 : 0, items: o.turns },
    title: "Talk",
  } as Unit;
  return {
    built: [{ messages: [], text: "", unit }],
    closed: new Set(o.closed ? [conversation] : []),
    spoken: new Map([[unit.id, lines]]),
    turns: new Map([[unit.id, []]]),
  };
};
const yes = (quote: string): FoundationAnswer => ({
  os: "27.2",
  reply: { author: "person", quote },
});

test("Apple's yes goes to his engine; a confirmed yes is a confirmed arrival; a second pass asks nothing", async () => {
  const s = sceneOf(() => yes("send me the lease by Friday"));
  const events = [msg("Can you send me the lease by Friday?")];
  await s.read(events);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
  expect(s.lines().map((l) => l.read)).toEqual([
    "arrival_trigger",
    "arrival_confirm",
  ]);
  const [confirmed] = readConfirmedArrivals(ago(60), s.where);
  expect(confirmed?.messages).toEqual([`whatsapp|${events[0]?.id}`]);
  await s.read(events);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
});

test("only a person's lines with an ask quoted go on: small talk and automated lines ask his engine nothing", async () => {
  const automated = sceneOf(() => ({
    os: "27.2",
    reply: { author: "automated", quote: "pay your invoice" },
  }));
  await automated.read([msg("Your invoice is ready: pay your invoice")]);
  // Apple calls small talk a person's with no quote (seen on made-up chats, 21 Nov 2026): it once sent nearly all on.
  const smallTalk = sceneOf(() => yes(""));
  await smallTalk.read([msg("Lovely evening, thanks again")]);
  const ask = sceneOf(() => yes("send me the lease"));
  await ask.read([msg("Can you send me the lease?")]);
  expect([automated, smallTalk, ask].map((s) => s.calls.engine)).toEqual([
    0, 0, 1,
  ]);
});

test("Thai lines and no Apple model go straight to both of his engine's reads; a refusal is stored, then read", async () => {
  const thai = sceneOf(() => yes("unused"));
  await thai.read([msg("ช่วยส่งเอกสารให้หน่อยได้ไหม")]);
  expect(thai.calls).toEqual({ apple: 0, engine: 2 });
  const none = sceneOf(() => ({ detail: "no helper", error: "unavailable" }));
  await none.read([msg("Can you check the contract?")]);
  expect(none.lines().map((l) => l.read)).toEqual([
    "arrival_confirm",
    "arrival_appointment",
  ]);
  const refused = sceneOf(() => ({ detail: "sensitive", error: "refused" }));
  await refused.read([msg("Can you check the contract?")]);
  expect(refused.lines().map((l) => l.read)).toEqual([
    "arrival_trigger",
    "arrival_confirm",
    "arrival_appointment",
  ]);
});

/** His engine agreeing on a made-up dinner two days ahead, quoting the booking line. */
const dinner = () => {
  const day = daysBefore(dayNow(), -2);
  return {
    agreed: true,
    allDay: false,
    end: null,
    link: null,
    people: ["Sam"],
    place: "Riverside",
    quote: "table for 2 is booked",
    start: `${day} 19:30`,
    title: "Dinner with Sam",
    zone: null,
  };
};
test("a meeting goes to the appointment read alone, apart from the ask rule: a booking asks nothing and is still read", async () => {
  const s = sceneOf(
    () => ({
      os: "27.2",
      reply: { author: "person", event: "yes", quote: "" },
    }),
    true,
    false,
    dinner()
  );
  const events = [msg("Your table for 2 is booked at Riverside, 19:30")];
  expect(await s.read(events)).toBe(1);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
  const read = s.lines().find((l) => l.read === "arrival_appointment");
  expect(read?.reply).toEqual({
    ...dinner(),
    end: `${dinner().start.slice(0, 10)} 20:30`,
  });
  // Read once: a second pass asks nothing and syncs nothing.
  expect(await s.read(events)).toBe(0);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
});

test("an ask and a meeting in one read go to both reads; offline, both wait and are asked on the next pass", async () => {
  const s = sceneOf(
    () => ({
      os: "27.2",
      reply: { author: "person", event: "yes", quote: "bring the plans" },
    }),
    true,
    false,
    dinner()
  );
  const events = [msg("Table for 2 is booked at 19:30, bring the plans")];
  expect(await s.read(events, false)).toBe(0);
  expect(s.calls).toEqual({ apple: 1, engine: 0 });
  expect(await s.read(events)).toBe(1);
  expect(s.calls).toEqual({ apple: 1, engine: 2 });
});

test("a grown chat is read for its new lines only, a new read of its own", async () => {
  const s = sceneOf(() => yes("send the slides"));
  const first = msg("Can you send the slides?");
  await s.read([first]);
  const second = msg("And send the slides to Ann too?");
  await s.read([first, second]);
  expect(s.lines().map((l) => l.messages)).toEqual([
    [`whatsapp|${first.id}`],
    [`whatsapp|${first.id}`],
    [`whatsapp|${second.id}`],
    [`whatsapp|${second.id}`],
  ]);
});

test("a 12,000-character thread is read as 3 chunks in one pass; offline, each pending chunk is re-cut exactly", async () => {
  const s = sceneOf(() => yes("send the slides"));
  const thread = Array.from({ length: 12 }, () =>
    msg(`Can you send the slides? ${"z".repeat(970)}`)
  );
  await s.read(thread, false);
  expect(s.calls).toEqual({ apple: 3, engine: 0 });
  await s.read(thread);
  expect(s.calls).toEqual({ apple: 3, engine: 3 });
  const keysOf = (read: string) =>
    s
      .lines()
      .filter((l) => l.read === read)
      .map((l) => l.messages);
  // Each confirm reads exactly one trigger's lines (asked newest first).
  expect(keysOf("arrival_confirm").map(String).toSorted()).toEqual(
    keysOf("arrival_trigger").map(String).toSorted()
  );
  expect(keysOf("arrival_trigger").flat()).toEqual(
    thread.map((m) => `whatsapp|${m.id}`)
  );
});

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
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
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
  expect(s.calls).toEqual({ apple: 3, engine: 3 });
  expect(
    s
      .lines()
      .filter((l) => l.read === "arrival_confirm")
      .flatMap((l) => l.messages)
      .toSorted()
  ).toEqual(
    [...long.spoken.values()]
      .flat()
      .map((l) => `lifelog|${l.ref}`)
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
  expect(s.calls).toEqual({ apple: 2, engine: 2 });
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

test("voice: a pending confirm whose conversation turns out not his asks his engine nothing", async () => {
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
  expect(s.calls).toEqual({ apple: 1, engine: 0 });
});

test("voice: a conversation reopened or a speaker corrected within one pass is read as the store's one read saw it", async () => {
  // A made-up closed conversation in the watcher's store: his turn, then Sam's; the words from a fake lifelog.
  const [first, last, late] = [ago(20), ago(12), ago(16)];
  const server = lifelogServer({
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
    const withTruth = { ...people, truth: { people: [] } as unknown as Truth };
    const voice = await readRecentVoice(dayNow(), withTruth.truth);
    // Before the words are fetched: reopened, a turn added inside its span, and his turn given to Sam.
    feed(false, [
      turnFixture(0, first, null, "Sam", "talk-r"),
      turnFixture(2, late, null, "Sam", "talk-r"),
    ]);
    const shown: string[] = [];
    await readArrivals(
      { built: [], fileEvents: [], voice },
      withTruth,
      ["Ozren"],
      {
        apple: (requests) => {
          shown.push(...requests.map((r) => r.text));
          return Promise.resolve(requests.map(() => yes("")));
        },
        confirmsToday: () => Promise.resolve(0),
        online: () => Promise.resolve(false),
        step: () =>
          Promise.resolve({
            end: (c: object) => c,
            llm: { engine: "codex", model: "test" },
            run: "r1",
          } as never),
        where: join(dir, "reopened"),
      }
    );
    // His turn and Sam's, as that read saw them; the reopened conversation's new turn is a later pass's.
    expect(shown.join("\n").split("\n")).toEqual([
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
  const s = sceneOf(() => yes("unused"), true, true);
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
  // Four chunks, each to both of his engine's reads, the first confirm failing: the next pass asks that one again,
  // never its appointment read made, and a third fetches nothing.
  await s.read([], true, 0, thai);
  await s.read([], true, 0, thai);
  await s.read([], true, 0, thai);
  expect(s.calls.engine).toBe(9);
  expect(s.fetched).toEqual([1, 1, 0]);
});

test("voice: a trigger left pending past midnight (the cap spent) is the night's, never confirmed the next day", async () => {
  const midnight = dayStart(dayNow()).getTime();
  setSystemTime(new Date(midnight - 30 * MIN));
  try {
    const s = sceneOf(() => yes("bring the plans"));
    const talk = voiceOf("late", { closed: true, spoke: true, turns: 2 });
    await s.read([], true, CONFIRMS_A_DAY, talk);
    setSystemTime(new Date(midnight + 30 * MIN));
    await s.read([], true, 0, talk);
    expect(s.calls).toEqual({ apple: 1, engine: 0 });
  } finally {
    setSystemTime();
  }
});

test("voice: lifelog unreachable, chats and mail are still read", async () => {
  const s = sceneOf(() => yes("send the slides"));
  await s.read([msg("Can you send the slides?")], true, 0, {
    ...voiceOf("talk", { closed: true, spoke: true, turns: 2 }),
    fails: true,
  });
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
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
    expect(s.calls).toEqual({ apple: 1, engine: 1 });
  } finally {
    setSystemTime();
  }
});

test("Apple failing (an outage) stores nothing and asks no confirm: the read is due again on the next pass", async () => {
  const answers: FoundationAnswer[] = [
    { detail: "ModelManagerError 1013", error: "failed" },
    yes("send the slides"),
  ];
  const s = sceneOf(() => answers.shift() ?? yes(""));
  const events = [msg("Can you send the slides?")];
  await s.read(events);
  expect(s.calls).toEqual({ apple: 1, engine: 0 });
  expect(s.lines()).toEqual([]);
  await s.read(events);
  expect(s.calls).toEqual({ apple: 2, engine: 1 });
});

test("his engine's no is stored and confirms nothing", async () => {
  const s = sceneOf(() => yes("send the slides"), false);
  await s.read([msg("Can you send the slides?")]);
  expect(readConfirmedArrivals(ago(60), s.where)).toEqual([]);
});

test("offline, Apple's yes is stored and its confirm waits; back online, the pending confirm is asked", async () => {
  const s = sceneOf(() => yes("send the slides"));
  const events = [msg("Can you send the slides?")];
  await s.read(events, false);
  expect(s.calls).toEqual({ apple: 1, engine: 0 });
  await s.read(events);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
  expect(readConfirmedArrivals(ago(60), s.where)).toHaveLength(1);
});

test("a pending confirm reads the same lines as the trigger; with one of them gone, it is the night's", async () => {
  const s = sceneOf(() => yes("send the slides"));
  const long = msg(`Can you send the slides? ${"x".repeat(6000)} END-MARK`);
  await s.read([long], false);
  await s.read([long]);
  // The confirm reads the long line whole, the same line as before Life went offline.
  expect(s.shown).toHaveLength(1);
  expect(s.shown[0]?.endsWith("END-MARK")).toBe(true);
  const gone = sceneOf(() => yes("send the slides"));
  const [a, b] = [msg("Can you send the slides?"), msg("Today if you can")];
  await gone.read([a, b], false);
  await gone.read([b]);
  expect(gone.calls.engine).toBe(0);
});

/** Two chats' asks, the second newer: under the cap's last room, only the newest is confirmed. */
const twoAsks = () => [
  msg("Can you send the slides?"),
  msg("Can you send the budget?", { chat: "c2", id: "whatsapp:c2" }),
];
test("an appointment read that fails is not counted, and is asked again on its own lines alone, new lines read apart", async () => {
  let fails = true;
  const s = sceneOf(
    () => ({ detail: "no helper", error: "unavailable" }),
    true,
    false,
    () => {
      if (fails) {
        fails = false;
        return Promise.reject(new Error("engine down"));
      }
      return Promise.resolve(dinner());
    }
  );
  const a = msg("Your table for 2 is booked at Riverside, 19:30");
  expect(await s.read([a])).toBe(0);
  expect(s.lines().map((l) => l.read)).toEqual(["arrival_confirm"]);
  // A new line in the same chat: the failed read is asked on the first line's keys, the new line read on its own.
  const b = msg("See you there");
  expect(await s.read([a, b])).toBe(2);
  expect(
    s
      .lines()
      .map((l) => `${l.read} ${l.messages.join(",")}`)
      .toSorted()
  ).toEqual(
    [
      `arrival_appointment whatsapp|${a.id}`,
      `arrival_appointment whatsapp|${b.id}`,
      `arrival_confirm whatsapp|${a.id}`,
      `arrival_confirm whatsapp|${b.id}`,
    ].toSorted()
  );
});

test("the day's cap counts both reads: one short of it, an ask and a meeting in one read make one call, the newest", async () => {
  const s = sceneOf(
    () => ({
      os: "27.2",
      reply: { author: "person", event: "yes", quote: "send it" },
    }),
    true,
    false,
    dinner()
  );
  await s.read(
    [msg("Can you send it? Table booked for 19:30")],
    true,
    CONFIRMS_A_DAY - 1
  );
  expect(s.calls.engine).toBe(1);
});

test("the day's cap counts the confirms already made: one short of it, one of two reads is confirmed, the newest", async () => {
  const s = sceneOf(() => yes("send it"));
  await s.read(twoAsks(), true, CONFIRMS_A_DAY - 1);
  expect(s.shown).toEqual([expect.stringContaining("the budget")]);
});

test("who wrote the confirmed lines: his own promise in a 1:1 chat names the other person, in a group no one", async () => {
  const peopleOf = async (chat: string) => {
    const s = sceneOf((text) =>
      text.includes("I'll send")
        ? yes("I'll send it tonight")
        : { os: "27.2", reply: { author: "automated", quote: "" } }
    );
    const earlier = msg("Morning Ozren", { chat });
    await s.read([earlier]);
    await s.read([
      earlier,
      msg("I'll send it tonight", { chat, fromMe: true, sender: "me" }),
    ]);
    return readConfirmedArrivals(ago(60), s.where).map((a) => a.people);
  };
  expect(await peopleOf(SAM)).toEqual([["person:sam"]]);
  expect(await peopleOf("120363000000000001@g.us")).toEqual([[]]);
});

test("a confirm filed in last month's file (its first message's month) is still read just after midnight UTC", () => {
  const where = join(dir, "month-edge");
  storeReply(
    {
      at: "2026-11-01T00:10:00.000Z",
      madeBy: stamp(
        { engine: "codex", model: "test" },
        "memory-arrival-confirm.v2",
        "r1"
      ),
      messages: ["whatsapp|whatsapp:edge"],
      people: [],
      promptDigest: "0123456789abcdef",
      read: "arrival_confirm",
      reply: { isActionable: true },
      schemaVersion: 1,
      starts: [0],
      unit: "unit_0000000000ed",
    } as ReadReply,
    "2026-10-31T23:50:00.000Z",
    where
  );
  expect(
    readConfirmedArrivals("2026-11-01T00:00:00.000Z", where).map((a) => a.unit)
  ).toEqual(["unit_0000000000ed"]);
});

// Last: it fills today's model log.
test("the day's cap counts the confirm calls in the model log, failed ones included", async () => {
  for (let i = 0; i < CONFIRMS_A_DAY - 1; i += 1) {
    log("model.run", {
      at: iso(clock().getTime()),
      ok: false,
      prompt: "memory-arrival-confirm.v2",
    });
  }
  const s = sceneOf(() => yes("send it"));
  await s.read(twoAsks(), true, null);
  expect(s.shown).toEqual([expect.stringContaining("the budget")]);
});
