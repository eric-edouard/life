import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  chapters,
  conversations,
  intelligenceRuns,
  ownerEdits,
  sources,
  timelineSpans,
  transcriptionJobs,
  transcripts,
} from "@lifelog/db/schema";
import { asc, eq } from "drizzle-orm";
import { PARSER_VERSION } from "./elevenlabs";
import { groupSource, markDirty } from "./grouping";
import { MacGone, type ModelCall } from "./providers";
import { rollingVoices } from "./rolling";
import { dueConversations, fingerprint } from "./runs";
import { setSwitches } from "./switches";
import { fakeAnswer, fakeModel, rangeOf, testDb } from "./testing";
import { rebuildTurns } from "./turns";
import { PROMPT_VERSION } from "./voices-call";

let env: Awaited<ReturnType<typeof testDb>>;

beforeAll(() => {
  env = testDb();
});
afterAll(() => {
  env.drop();
});
beforeEach(() => {
  env.reset();
  // Summaries on (off by default), as these tests roll them.
  setSwitches(env.db, { ai: true });
});

const SOURCE = "pendant-1";
const T0 = Date.parse("2026-10-14T10:00:00Z");
const at = (s: number) => T0 + s * 1000;
const iso = (s: number) => new Date(at(s)).toISOString();

// A block of `n` turns of 10 s from `start` (seconds): its job, transcript and turns, the span the
// phone sends for it (speech throughout), then grouping with heard-through at `heard`.
function block(start: number, n: number, heard: number) {
  const end = start + n * 10;
  const [job] = env.db
    .insert(transcriptionJobs)
    .values({
      audioSha256: randomUUID(),
      billableSeconds: n * 10,
      captureEnd: new Date(at(end)),
      captureStart: new Date(at(start)),
      map: { segments: [[at(start), at(end)]], separatorMs: 0 },
      preparedDurationSeconds: n * 10,
      settings: { keyterms: [], languageCode: null, numSpeakers: null },
      settingsHash: randomUUID(),
      sourceId: SOURCE,
      state: "completed",
    })
    .returning()
    .all();
  if (!job) {
    throw new Error("no job");
  }
  const turns = Array.from({ length: n }, (_, i) => ({
    end: i * 10 + 8,
    speakerId: `speaker_${i % 2}`,
    start: i * 10,
    text: `Turn ${start / 10 + i}.`,
  }));
  env.db
    .insert(transcripts)
    .values({
      createdAt: new Date(Date.now() - 3_600_000),
      jobId: job.id,
      languageCode: "eng",
      parsed: { languageCode: "eng", languageProbability: 1, turns, words: [] },
      parserVersion: PARSER_VERSION,
      raw: {},
    })
    .run();
  rebuildTurns(env.db, job.id);
  env.db
    .insert(sources)
    .values({ heardThrough: new Date(at(heard)), id: SOURCE })
    .onConflictDoUpdate({
      set: { heardThrough: new Date(at(heard)) },
      target: sources.id,
    })
    .run();
  env.db
    .insert(timelineSpans)
    .values({
      endAt: new Date(at(end)),
      facts: {
        audible: [[iso(start), iso(end)]],
        breaks: [],
        pauses: [],
        speech: [[iso(start), iso(end)]],
        unanalyzed: [],
      },
      firstPage: start,
      sourceId: SOURCE,
      startAt: new Date(at(start)),
    })
    .run();
  markDirty(env.db, [SOURCE], [at(start), at(end)]);
  groupSource(env.db, SOURCE);
}

// Heard-through moves on: conversations it passed by 5 minutes close.
function hear(heard: number) {
  env.db
    .update(sources)
    .set({ heardThrough: new Date(at(heard)) })
    .where(eq(sources.id, SOURCE))
    .run();
  groupSource(env.db, SOURCE);
}

test("the fingerprint is the one Postgres made: 'open:' while open, md5 of the turn refs in order", () => {
  block(0, 3, 0);
  const [c] = env.db.select().from(conversations).all();
  const job = env.db.query.transcriptionJobs.findFirst().sync();
  if (!(c && job)) {
    throw new Error("no conversation");
  }
  const md5 = (s: string) => createHash("md5").update(s).digest("hex");
  const refs = [0, 1, 2].map((i) => `${job.id}:${i}`).join(",");
  expect(fingerprint(env.db, c.id)).toBe(`open:${md5(refs)}`);
  hear(1000);
  expect(fingerprint(env.db, c.id)).toBe(md5(refs));
});

// The turn ids each call was asked about.
const asked = (calls: ModelCall[]) => calls.map((c) => rangeOf(c));
// A window of about this many characters holds four of these turns.
const SMALL = 330;

const conversation = () =>
  env.db
    .select()
    .from(conversations)
    .orderBy(asc(conversations.captureStartedAt))
    .all()
    .filter((c) => c.retiredAt === null);

test("an open conversation rolls only a full window; closing reads the tail; each turn is read once", async () => {
  const model = fakeModel();
  const rolling = rollingVoices(env.db, { mac: model, windowChars: SMALL });
  block(0, 10, 100);
  await rolling.drain();
  // Turns 0-3 and 4-7 are full windows; 8-9 is a partial one: it waits.
  expect(asked(model.calls)).toEqual([
    [0, 3],
    [4, 7],
  ]);
  expect(conversation()[0]?.closedAt).toBeNull();

  // Nothing new: no call. More talk: the partial window is full now.
  await rolling.drain();
  expect(model.calls.length).toBe(2);
  block(100, 10, 200);
  await rolling.drain();
  // The last window is the tail: it waits too.
  expect(asked(model.calls).slice(2)).toEqual([
    [8, 11],
    [12, 15],
  ]);

  // Closed: the tail is read, nothing before it.
  const calls = model.calls.length;
  hear(600);
  await rolling.drain();
  expect(asked(model.calls).slice(calls)).toEqual([[16, 19]]);
  const runs = env.db.select().from(intelligenceRuns).all();
  // Every roll is a run of the Mac's, at no cost, over the turns read so far.
  expect(runs.map((r) => [r.state, r.provider, r.costUsd])).toEqual(
    runs.map(() => ["valid", "claude-code", 0])
  );
  // A run makes no chapter, no split.
  expect(env.db.select().from(chapters).all()).toEqual([]);
  expect(env.db.select().from(ownerEdits).all()).toEqual([]);
});

test("one window of an open conversation is no run; the conversation closing reads it", async () => {
  const model = fakeModel();
  const rolling = rollingVoices(env.db, { mac: model, windowChars: 100_000 });
  block(0, 10, 100);
  await rolling.drain();
  expect(model.calls.length).toBe(0);
  expect(env.db.select().from(intelligenceRuns).all()).toEqual([]);
  hear(600);
  await rolling.drain();
  expect(asked(model.calls)).toEqual([[0, 9]]);
});

test("summaries off: a due conversation makes no run and nothing is due; turned on, it rolls", async () => {
  setSwitches(env.db, { ai: false });
  const model = fakeModel();
  const rolling = rollingVoices(env.db, { mac: model, windowChars: 100_000 });
  block(0, 10, 1000);
  await rolling.drain();
  expect(env.db.select().from(intelligenceRuns).all()).toEqual([]);
  expect(rolling.due()).toEqual([]);
  setSwitches(env.db, { ai: true });
  await rolling.drain();
  const runs = env.db.select().from(intelligenceRuns).all();
  expect(runs.map((r) => r.state)).toEqual(["valid"]);
});

// The owner's Generate of the conversation at `id`, and every roll it leads to.
test("with the Mac away nothing is called; a roll it dropped resumes where it stopped", async () => {
  let ready = false;
  let dropped = false;
  const model = Object.assign(
    fakeModel(() => {
      if (!dropped) {
        dropped = true;
        throw new MacGone("the Mac is away");
      }
      return fakeAnswer();
    }),
    { ready: () => ready }
  );
  const rolling = rollingVoices(env.db, { mac: model, windowChars: 100_000 });
  block(0, 10, 1000);
  await rolling.drain();
  await rolling.drain();
  expect(model.calls.length).toBe(0);
  expect(env.db.select().from(intelligenceRuns).all()).toEqual([]);

  ready = true;
  await rolling.drain();
  const [waiting] = env.db.select().from(intelligenceRuns).all();
  expect(waiting?.state).toBe("waiting");
  await rolling.drain();
  const runs = env.db.select().from(intelligenceRuns).all();
  expect(runs.map((r) => `${r.id} ${r.state}`)).toEqual([
    `${waiting?.id} valid`,
  ]);
  // The run started again in place: asked twice (the Mac dropped the first), one run.
  expect(asked(model.calls)).toEqual([
    [0, 9],
    [0, 9],
  ]);
});

test("at most one roll per conversation at a time; one asked meanwhile follows", async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  let running = 0;
  let most = 0;
  const model = fakeModel(async () => {
    running += 1;
    most = Math.max(most, running);
    await gate;
    running -= 1;
    return fakeAnswer();
  });
  const rolling = rollingVoices(env.db, { mac: model, windowChars: SMALL });
  block(0, 10, 100);
  const first = rolling.drain();
  await Bun.sleep(50);
  block(100, 10, 200);
  const more = [rolling.drain(), rolling.drain()];
  await Bun.sleep(50);
  expect(model.calls.length).toBe(1);
  release();
  await Promise.all([first, ...more]);
  await rolling.idle();
  expect(most).toBe(1);
  expect(asked(model.calls)).toEqual([
    [0, 3],
    [4, 7],
    [8, 11],
    [12, 15],
  ]);
});

test("without the Mac nothing rolls", async () => {
  const rolling = rollingVoices(env.db, { mac: null });
  block(0, 10, 100);
  await rolling.drain();
  await rolling.drain();
  expect(env.db.select().from(intelligenceRuns).all()).toEqual([]);
});

test("a conversation is due whenever its words change, however late: an old one gets its summary when the Mac returns", async () => {
  const OLD = -3 * 86_400;
  let ready = false;
  let dropped = false;
  const model = Object.assign(
    fakeModel(() => {
      if (!dropped) {
        dropped = true;
        throw new MacGone("the Mac is away");
      }
      return fakeAnswer();
    }),
    { ready: () => ready }
  );
  const rolling = rollingVoices(env.db, { mac: model, windowChars: 100_000 });
  // Three days ago, closed long since; its words come only now (held audio released).
  block(OLD, 10, 1000);
  expect(conversation()[0]?.closedAt).not.toBeNull();
  await rolling.drain();
  expect(model.calls.length).toBe(0);
  // The Mac comes, drops the roll, and comes back: it resumes and settles.
  ready = true;
  await rolling.drain();
  expect(env.db.select().from(intelligenceRuns).all()[0]?.state).toBe(
    "waiting"
  );
  await rolling.drain();
  expect(
    env.db
      .select()
      .from(intelligenceRuns)
      .all()
      .map((r) => r.state)
  ).toEqual(["valid"]);
  // Read as they are: not due again.
  const calls = model.calls.length;
  await rolling.drain();
  expect(model.calls.length).toBe(calls);
});

test("a failed roll is tried again 5 minutes after it failed, then 10, 20, 40, then once an hour", () => {
  block(0, 3, 0);
  const [c] = env.db.select().from(conversations).all();
  if (!c) {
    throw new Error("no conversation");
  }
  // `n` failed runs, the last one `minutes` ago.
  const failed = (n: number, minutes: number) => {
    env.db.delete(intelligenceRuns).run();
    for (let i = 0; i < n; i += 1) {
      const created = new Date(Date.now() - minutes * 60_000 - (n - i) * 1000);
      env.db
        .insert(intelligenceRuns)
        .values({
          conversationId: c.id,
          createdAt: created,
          model: "m",
          promptVersion: PROMPT_VERSION,
          provider: "claude-code",
          state: "failed",
          turns: [],
          updatedAt: new Date(Date.now() - minutes * 60_000),
        })
        .run();
    }
  };
  const later = () => dueConversations(env.db, [c.id])[0]?.later;
  for (const [n, wait] of [
    [1, 5],
    [2, 10],
    [3, 20],
    [4, 40],
    [5, 60],
    [8, 60],
  ] as const) {
    failed(n, wait - 1);
    expect(later()).toBe(true);
    failed(n, wait + 1);
    expect(later()).toBe(false);
  }
});
