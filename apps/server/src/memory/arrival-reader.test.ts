import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, daysBefore, HOUR, iso, MIN } from "../core/clock";
import { log } from "../core/log";
import type { FoundationAnswer } from "../models/foundation-model";
import { stamp } from "../models/llm";
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
import { READS, readConfirmedArrivals, readReplies } from "./read-replies";
import { OWNER, type Truth } from "./read-truth";
import { voiceUnitId } from "./unit-ids";
import { applyRules, messageUnits } from "./units";
import { dayNow, dayStart, localDate, time } from "./zones";

// Made-up chats with Sam, someone he knows; Apple and his engine are fakes counting their calls.
const SAM = "33600000001@s.whatsapp.net";
const SAM_MAIL = "sam@example.com";
const known = (h: string) =>
  h === SAM || h === SAM_MAIL ? "person:sam" : null;
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
/** A made-up mail from Sam in one thread: Apple sieves mail alone, chats and voice go straight to his engine. */
const mail = (text: string, over: Partial<SourceEvent> = {}): SourceEvent => {
  const m = msg(text, {
    chat: "thread-1",
    chatName: "Slides",
    sender: SAM_MAIL,
    source: "mail",
    ...over,
  });
  return { ...m, id: over.id ?? m.id.replace("whatsapp", "mail") };
};
const people = { nameOf: (r: string) => r, resolve: known };

let dir = "";
let trial = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "arrival-reader-"));
});
afterAll(() => rm(dir, { force: true, recursive: true }));

/** His engine's confirm saying one normal ask is left; the default answer. */
const ASK = {
  event: "no",
  inProgress: [],
  left: [{ kind: "ask", priority: "normal", what: "send it" }],
};
/** His engine's confirm saying nothing is left. */
const NOTHING = { event: "no", inProgress: [], left: [] };

/** A scene: its own replies folder, Apple answering `apple`, his engine answering `confirm`, both counted. */
const sceneOf = (
  apple: (text: string) => FoundationAnswer,
  confirm: object = ASK,
  /** His engine fails its first call. */
  failsFirst = false,
  /** His engine's answer to an appointment read, or a call that may fail. */
  meeting: object | (() => Promise<object>) = { agreed: false }
) => {
  trial += 1;
  const where = join(dir, `trial-${trial}`);
  const calls = { apple: 0, engine: 0 };
  const step = {
    ask: (q: {
      input: { firstDay?: string; lines: string[]; now?: string };
    }) => {
      shown.push(q.input.lines.join("\n"));
      nows.push(q.input.now ?? "");
      calls.engine += 1;
      if (failsFirst && calls.engine === 1) {
        return Promise.reject(new Error("engine down"));
      }
      if (!q.input.firstDay) {
        return Promise.resolve(confirm);
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
  const nows: string[] = [];
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
        ...(voice?.spoken
          ? {
              spoken: (turns: Map<string, unknown>) => {
                fetched.push(turns.size);
                const spoken = voice.spoken ?? new Map();
                return voice.fails
                  ? Promise.reject(new Error("lifelog unreachable"))
                  : Promise.resolve(spoken);
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
  return { calls, fetched, lines, nows, read, shown, where };
};
/** Today's voice as the reader is given it, and the words its turns' fetch gives back. */
interface Voice extends RecentVoice {
  /** Fetching the turns' words fails (lifelog unreachable). */
  fails?: boolean;
  spoken?: Map<string, SourceLine[]>;
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
): Voice & { spoken: Map<string, SourceLine[]> } => {
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
  reply: { quote, writer: "person" },
});

test("Apple's yes on a mail goes to his engine; a confirmed yes is a confirmed arrival; a second pass asks nothing", async () => {
  const s = sceneOf(() => yes("send me the lease by Friday"));
  const events = [mail("Can you send me the lease by Friday?")];
  await s.read(events);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
  expect(s.lines().map((l) => l.read)).toEqual([
    "arrival_trigger",
    "arrival_confirm",
  ]);
  const [confirmed] = readConfirmedArrivals(ago(60), s.where);
  expect(confirmed?.messages).toEqual([`mail|${events[0]?.id}`]);
  await s.read(events);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
});

test("Apple sieves mail: an automated mail needing nothing asks his engine nothing; one that needs him, or a person's, goes on", async () => {
  const automatedOf = (needs: string) =>
    sceneOf(() => ({ os: "27.2", reply: { needs, writer: "automated" } }));
  const notice = automatedOf("no");
  await notice.read([mail("Your order has shipped")]);
  const bill = automatedOf("yes");
  await bill.read([mail("Your invoice is due: pay it by Friday")]);
  const person = sceneOf(() => yes(""));
  await person.read([mail("Lovely evening, thanks again")]);
  expect([notice, bill, person].map((s) => s.calls.engine)).toEqual([0, 1, 1]);
});

test("chats go straight to his engine's confirm alone, never to Apple; a chat that sets a meeting is read by the appointment read on the next pass", async () => {
  const s = sceneOf(
    () => yes("unused"),
    { ...ASK, event: "yes" },
    false,
    dinner()
  );
  const events = [msg("Can you check the contract? Dinner at 19:30")];
  expect(await s.read(events)).toBe(0);
  expect(s.calls).toEqual({ apple: 0, engine: 1 });
  expect(s.lines().map((l) => l.read)).toEqual(["arrival_confirm"]);
  expect(await s.read(events)).toBe(1);
  expect(s.calls).toEqual({ apple: 0, engine: 2 });
  expect(s.lines().map((l) => l.read)).toEqual([
    "arrival_confirm",
    "arrival_appointment",
  ]);
  // Both made, on the same keys: a third pass asks nothing.
  expect(await s.read(events)).toBe(0);
  expect(s.calls.engine).toBe(2);
});

test("Thai mail and no Apple model go straight to the confirm; a refusal is stored, then both reads follow", async () => {
  const thai = sceneOf(() => yes("unused"));
  await thai.read([mail("ช่วยส่งเอกสารให้หน่อยได้ไหม")]);
  expect(thai.calls).toEqual({ apple: 0, engine: 1 });
  const none = sceneOf(() => ({ detail: "no helper", error: "unavailable" }));
  await none.read([mail("Can you check the contract?")]);
  expect(none.calls).toEqual({ apple: 1, engine: 1 });
  expect(none.lines().map((l) => l.read)).toEqual(["arrival_confirm"]);
  const refused = sceneOf(() => ({ detail: "sensitive", error: "refused" }));
  await refused.read([mail("Can you check the contract?")]);
  // His engine's two reads run at once: stored in either order.
  expect(
    refused
      .lines()
      .map((l) => l.read)
      .toSorted()
  ).toEqual(["arrival_appointment", "arrival_confirm", "arrival_trigger"]);
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
test("a meeting goes to the appointment read alone, apart from the ask rule: an automated booking asks no confirm and is still read", async () => {
  const s = sceneOf(
    () => ({
      os: "27.2",
      reply: { event: "yes", writer: "automated" },
    }),
    ASK,
    false,
    dinner()
  );
  const events = [mail("Your table for 2 is booked at Riverside, 19:30")];
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
      reply: { event: "yes", needs: "yes", writer: "person" },
    }),
    ASK,
    false,
    dinner()
  );
  const events = [mail("Table for 2 is booked at 19:30, bring the plans")];
  expect(await s.read(events, false)).toBe(0);
  expect(s.calls).toEqual({ apple: 1, engine: 0 });
  expect(await s.read(events)).toBe(1);
  expect(s.calls).toEqual({ apple: 1, engine: 2 });
});

test("a grown chat is read for its new lines only, a new read of its own", async () => {
  const s = sceneOf(() => yes("send the slides"));
  const first = mail("Can you send the slides?");
  await s.read([first]);
  const second = mail("And send the slides to Ann too?");
  await s.read([first, second]);
  expect(s.lines().map((l) => l.messages)).toEqual([
    [`mail|${first.id}`],
    [`mail|${first.id}`],
    [`mail|${second.id}`],
    [`mail|${second.id}`],
  ]);
});

test("a 12,000-character thread is read as 3 chunks in one pass; offline, each pending chunk is re-cut exactly", async () => {
  const s = sceneOf(() => yes("send the slides"));
  const thread = Array.from({ length: 12 }, () =>
    mail(`Can you send the slides? ${"z".repeat(970)}`)
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
    thread.map((m) => `mail|${m.id}`)
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

test("voice: lifelog unreachable, chats and mail are still read", async () => {
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

test("Apple failing (an outage) stores nothing and asks no confirm: the read is due again on the next pass", async () => {
  const answers: FoundationAnswer[] = [
    { detail: "ModelManagerError 1013", error: "failed" },
    yes("send the slides"),
  ];
  const s = sceneOf(() => answers.shift() ?? yes(""));
  const events = [mail("Can you send the slides?")];
  await s.read(events);
  expect(s.calls).toEqual({ apple: 1, engine: 0 });
  expect(s.lines()).toEqual([]);
  await s.read(events);
  expect(s.calls).toEqual({ apple: 2, engine: 1 });
});

test("his engine's no is stored and confirms nothing", async () => {
  const s = sceneOf(() => yes("send the slides"), NOTHING);
  await s.read([mail("Can you send the slides?")]);
  expect(readConfirmedArrivals(ago(60), s.where)).toEqual([]);
});

test("offline, Apple's yes is stored and its confirm waits; back online, the pending confirm is asked", async () => {
  const s = sceneOf(() => yes("send the slides"));
  const events = [mail("Can you send the slides?")];
  await s.read(events, false);
  expect(s.calls).toEqual({ apple: 1, engine: 0 });
  await s.read(events);
  expect(s.calls).toEqual({ apple: 1, engine: 1 });
  expect(readConfirmedArrivals(ago(60), s.where)).toHaveLength(1);
});

test("a pending confirm reads the same lines as the trigger; with one of them gone, it is the night's", async () => {
  const s = sceneOf(() => yes("send the slides"));
  const long = mail(`Can you send the slides? ${"x".repeat(6000)} END-MARK`);
  await s.read([long], false);
  await s.read([long]);
  // The confirm reads the long line whole, the same line as before Life went offline.
  expect(s.shown).toHaveLength(1);
  expect(s.shown[0]?.endsWith("END-MARK")).toBe(true);
  const gone = sceneOf(() => yes("send the slides"));
  const [a, b] = [mail("Can you send the slides?"), mail("Today if you can")];
  await gone.read([a, b], false);
  await gone.read([b]);
  expect(gone.calls.engine).toBe(0);
});

/** Two chats' asks, the second newer: under the cap's last room, only the newest is confirmed. */
const twoAsks = () => [
  mail("Can you send the slides?"),
  mail("Can you send the budget?", { chat: "c2", id: "mail:c2" }),
];
test("an appointment read that fails is not counted, and is asked again on its own lines alone, new lines read apart", async () => {
  let fails = true;
  // Apple's answer this pass: a refusal at first (both reads follow), then back.
  const apple: FoundationAnswer[] = [{ detail: "sensitive", error: "refused" }];
  const s = sceneOf(
    () => apple[0] as FoundationAnswer,
    ASK,
    false,
    () => {
      if (fails) {
        fails = false;
        return Promise.reject(new Error("engine down"));
      }
      return Promise.resolve(dinner());
    }
  );
  const a = mail("Your table for 2 is booked at Riverside, 19:30");
  expect(await s.read([a])).toBe(0);
  expect(s.lines().map((l) => l.read)).toEqual([
    "arrival_trigger",
    "arrival_confirm",
  ]);
  // A new line in the same thread, Apple back and saying it is automated with no meeting: the failed read is asked on
  // the first line's keys alone, once; the new line is Apple's alone.
  apple[0] = {
    os: "27.2",
    reply: { event: "no", writer: "automated" },
  };
  const b = mail("See you there");
  expect(await s.read([a, b])).toBe(1);
  expect(await s.read([a, b])).toBe(0);
  expect(
    s
      .lines()
      .map((l) => `${l.read} ${l.messages.join(",")}`)
      .toSorted()
  ).toEqual(
    [
      `arrival_appointment mail|${a.id}`,
      `arrival_confirm mail|${a.id}`,
      `arrival_trigger mail|${a.id}`,
      `arrival_trigger mail|${b.id}`,
    ].toSorted()
  );
});

test("the day's cap counts both reads: one short of it, an ask and a meeting in one read make one call, the newest", async () => {
  const s = sceneOf(
    () => ({
      os: "27.2",
      reply: { event: "yes", needs: "yes", writer: "person" },
    }),
    ASK,
    false,
    dinner()
  );
  await s.read(
    [mail("Can you send it? Table booked for 19:30")],
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
    const s = sceneOf(() => yes("unused"));
    const earlier = msg("Morning Ozren", { chat });
    await s.read([earlier]);
    await s.read([
      earlier,
      msg("I'll send it tonight", { chat, fromMe: true, sender: "me" }),
    ]);
    // The newest confirmed arrival is the one holding his promise.
    return readConfirmedArrivals(ago(60), s.where).at(-1)?.people;
  };
  expect(await peopleOf(SAM)).toEqual(["person:sam"]);
  expect(await peopleOf("120363000000000001@g.us")).toEqual([]);
});

test("a chat read shows the confirm the whole sitting, an answered line of the other person included, and the time now", async () => {
  const s = sceneOf(() => yes("unused"));
  await s.read([
    msg("Can you send the lease?", { at: ago(40) }),
    msg("Sent it", { at: ago(35), fromMe: true, sender: "me" }),
    msg("And the budget?", { at: ago(30) }),
  ]);
  expect(s.calls).toEqual({ apple: 0, engine: 1 });
  expect(s.shown[0]?.split("\n")).toEqual([
    expect.stringContaining("Can you send the lease?"),
    expect.stringContaining("Sent it"),
    expect.stringContaining("And the budget?"),
  ]);
  expect(s.nows).toEqual([time(clock().toISOString())]);
});

test("two unread lines 7 hours apart are two reads, each shown its own sitting: a stored line is always one the confirm saw", async () => {
  const base = dayStart(dayNow()).getTime() + HOUR;
  setSystemTime(new Date(base + 8 * HOUR));
  try {
    const s = sceneOf(() => yes("unused"));
    await s.read([
      msg("Can you call me about the lease?", { at: iso(base) }),
      msg("Also, the budget is due Friday", { at: iso(base + 7 * HOUR) }),
    ]);
    expect(s.calls).toEqual({ apple: 0, engine: 2 });
    expect(s.shown.toSorted()).toEqual([
      expect.stringContaining("Can you call me about the lease?"),
      expect.stringContaining("Also, the budget is due Friday"),
    ]);
    expect(s.shown.every((t) => t.split("\n").length === 1)).toBe(true);
  } finally {
    setSystemTime();
  }
});

test("a confirm leaving only a low thing is stored and kept, but does not wake", async () => {
  const low = {
    ...ASK,
    left: [{ kind: "ask", priority: "low", what: "send it" }],
  };
  const s = sceneOf(() => yes("unused"), low);
  await s.read([msg("Can you send the lease?")]);
  expect(readConfirmedArrivals(ago(60), s.where)).toEqual([
    expect.objectContaining({ wakes: false }),
  ]);
});

test("a confirm that saw him in the middle of something is read again once the chat has been quiet 6 hours, and not a third time", async () => {
  const base = dayStart(dayNow()).getTime() + HOUR;
  const middle = { ...NOTHING, inProgress: ["answering the lease"] };
  const s = sceneOf(() => yes("unused"), middle);
  const events = [
    msg("Can you send the lease?", { at: iso(base) }),
    msg("Looking now", { at: iso(base + MIN), fromMe: true, sender: "me" }),
  ];
  try {
    setSystemTime(new Date(base + 40 * MIN));
    await s.read(events);
    expect(s.calls.engine).toBe(1);
    setSystemTime(new Date(base + 2 * HOUR));
    await s.read(events);
    expect(s.calls.engine).toBe(1);
    setSystemTime(new Date(base + 7 * HOUR));
    await s.read(events);
    expect(s.calls.engine).toBe(2);
    // The new read is on the same keys.
    const [first, again] = s.lines().map((l) => l.messages);
    expect(again).toEqual(first);
    await s.read(events);
    expect(s.calls.engine).toBe(2);
  } finally {
    setSystemTime();
  }
});

// Last: it fills today's model log.
test("the day's cap counts the confirm calls in the model log, failed ones included", async () => {
  for (let i = 0; i < CONFIRMS_A_DAY - 1; i += 1) {
    log("model.run", {
      at: iso(clock().getTime()),
      ok: false,
      prompt: READS.arrival_confirm.prompt,
    });
  }
  const s = sceneOf(() => yes("send it"));
  await s.read(twoAsks(), true, null);
  expect(s.shown).toEqual([expect.stringContaining("the budget")]);
});
