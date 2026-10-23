import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { countRows } from "@life/voice-db";
import {
  changeLog,
  chapters,
  type Turn,
  transcriptionJobs,
  turns,
  type Word,
} from "@life/voice-db/schema";
import { asc, eq } from "drizzle-orm";
import { mapJob, seedConversation, seedTranscript, testDb } from "./testing";
import { rebuildTurns } from "./turns";

let env: Awaited<ReturnType<typeof testDb>>;

beforeAll(() => {
  env = testDb();
});
afterAll(() => {
  env.drop();
});
beforeEach(() => {
  env.reset();
});

const T0 = Date.parse("2026-10-10T08:00:00Z");
const min = (m: number) => T0 + m * 60_000;
const word = (text: string, start: number, end: number): Word => ({
  end,
  logprob: 0,
  spacing: " ",
  speakerId: "speaker_0",
  start,
  text,
});
// Two turns, at 1 s and 61 s of the prepared audio.
const spoken: Turn[] = [
  { end: 3, speakerId: "speaker_0", start: 1, text: "Hello there" },
  { end: 63, speakerId: "speaker_0", start: 61, text: "Second turn" },
];
const words = [
  word("Hello", 1, 2),
  word("there", 2, 3),
  word("Second", 61, 62),
  word("turn", 62, 63),
];
// A minute kept from `from`, then a minute kept from `from + 2 min`, 400 ms apart: 61 s of
// prepared audio sits 600 ms into the second interval.
const twoMinutes = (from: number): [number, number][] => [
  [from, from + 60_000],
  [from + 120_000, from + 180_000],
];

function transcribed(sha?: string) {
  const jobId = seedTranscript(env.db, spoken, words);
  if (sha) {
    env.db
      .update(transcriptionJobs)
      .set({ audioSha256: sha })
      .where(eq(transcriptionJobs.id, jobId))
      .run();
  }
  return jobId;
}

const mapped = (jobId: string, segments: [number, number][]) =>
  env.db
    .update(transcriptionJobs)
    .set({ map: { segments, separatorMs: 400 } })
    .where(eq(transcriptionJobs.id, jobId))
    .run();

const turnsOf = (jobId: string) =>
  env.db
    .select()
    .from(turns)
    .where(eq(turns.jobId, jobId))
    .orderBy(asc(turns.turnIndex))
    .all();

test("a mapped job's turns land in capture time", () => {
  const job = transcribed();
  mapped(job, twoMinutes(min(0)));
  expect(rebuildTurns(env.db, job)).toBe(2);
  const [one, two] = turnsOf(job);
  expect(one?.startAt.getTime()).toBe(min(0) + 1000);
  // 61 s: 60.4 s are the first interval and its separator, so 600 ms into the second.
  expect(two?.startAt.getTime()).toBe(min(2) + 600);
  expect(two?.endAt.getTime()).toBeGreaterThan(two?.startAt.getTime() ?? 0);
  expect(two).toMatchObject({ language: "eng", speakerLabel: "speaker_0" });
  expect(two?.words.map((w) => w.text)).toEqual(["Second", "turn"]);
  expect(two?.words[0]?.start).toBe(min(2) + 600);
});

test("a joined job's turns land where its map's `starts` puts each stretch", () => {
  const job = transcribed();
  // Joined from two fragments (audio.ts): the second stretch begins 20.5 ms past the uniform rule's
  // 60.4 s, in the first fragment's padding and the second's encoder delay.
  env.db
    .update(transcriptionJobs)
    .set({
      map: {
        segments: twoMinutes(min(0)),
        separatorMs: 400,
        starts: [0, 60_420.5],
      },
    })
    .where(eq(transcriptionJobs.id, job))
    .run();
  rebuildTurns(env.db, job);
  const [, two] = turnsOf(job);
  // 61 s is 579.5 ms into the second stretch.
  expect(two?.startAt.getTime()).toBe(min(2) + 580);
  expect(two?.words.map((w) => w.start)).toEqual([min(2) + 580, min(2) + 1580]);
});

test("a word ends in the interval it starts in, and its turn with its last word", () => {
  // Real-shaped (Oct 13): the provider stretched "Des" from 1.2 s over the rest of an 8 s
  // interval, a separator, a 5 s interval and into a third one, minutes later in capture time.
  const job = seedTranscript(
    env.db,
    [{ end: 15, speakerId: "speaker_0", start: 1.2, text: "Des bon" }],
    [word("Des", 1.2, 14.6), word("bon", 14.6, 15)]
  );
  mapped(job, [
    [min(0), min(0) + 8000],
    [min(1), min(1) + 5000],
    [min(2), min(3)],
  ]);
  rebuildTurns(env.db, job);
  const [turn] = turnsOf(job);
  // 14.6 s: 8 s, a separator, 5 s and a separator before the third interval, so 800 ms into it.
  expect(turn?.words.map((w) => [w.start, w.end])).toEqual([
    [min(0) + 1200, min(0) + 8000],
    [min(2) + 800, min(2) + 1200],
  ]);
  expect(turn?.endAt.getTime()).toBe(min(2) + 1200);
});

test("rebuilding replaces a job's turns; a job without a map has none", () => {
  const job = transcribed();
  mapped(job, twoMinutes(min(0)));
  rebuildTurns(env.db, job);
  env.db.delete(turns).run();
  expect(rebuildTurns(env.db, job)).toBe(2);
  expect(rebuildTurns(env.db, job)).toBe(2);
  expect(countRows(env.db, turns)).toBe(2);
  const unmapped = transcribed();
  expect(rebuildTurns(env.db, unmapped)).toBe(0);
});

test("a job landing before another logs each of the conversation's chapters by its own id", () => {
  const { id } = seedConversation(env.db, spoken, { at: min(0) });
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  env.db
    .insert(chapters)
    .values(
      ids.map((chapter, i) => ({
        conversationId: id,
        endAt: new Date(min(i + 1)),
        id: chapter,
        startAt: new Date(min(i)),
      }))
    )
    .run();
  // Its first turn (31 s in) lands before the other job's second one (61 s in).
  mapJob(env.db, transcribed(), [[min(0) + 30_000, min(1) + 30_000]]);
  const logged = env.db
    .select({ ref: changeLog.ref })
    .from(changeLog)
    .where(eq(changeLog.kind, "chapter"))
    .all();
  expect(logged.map((r) => r.ref).sort()).toEqual([...ids].sort());
});
