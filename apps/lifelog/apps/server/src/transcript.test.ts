import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { conversations, transcriptionJobs } from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { mapJob, seedTranscript, testDb } from "./testing";
import { captureMillis, loadTurns } from "./transcript";

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
// A job with one 10-second turn at the start of each minute, its audio kept from `from`.
const job = (texts: string[], from: number) => {
  const jobId = seedTranscript(
    env.db,
    texts.map((text, i) => ({
      end: i * 60 + 10,
      speakerId: "speaker_0",
      start: i * 60,
      text,
    }))
  );
  mapJob(env.db, jobId, [[from, from + texts.length * 60_000]]);
  return jobId;
};

const conversation = (from: number, to: number) => {
  const id = randomUUID();
  env.db
    .insert(conversations)
    .values({
      captureEndedAt: new Date(to),
      captureStartedAt: new Date(from),
      id,
    })
    .run();
  return id;
};
const textsOf = (id: string) => loadTurns(env.db, id)?.turns.map((t) => t.text);

test("turns come in capture order; each voice without a person is one numbered speaker", () => {
  job(["c", "d"], min(30));
  job(["a", "b"], min(0));
  const id = conversation(min(0), min(32));
  const loaded = loadTurns(env.db, id);
  expect(loaded?.turns.map((t) => t.text)).toEqual(["a", "b", "c", "d"]);
  // Labels restart in every job: speaker_0 of each job is its own voice.
  expect(loaded?.turns.map((t) => t.speaker)).toEqual([
    "Speaker 1",
    "Speaker 1",
    "Speaker 2",
    "Speaker 2",
  ]);
});

test("a conversation shows the turns starting in its range", () => {
  job(["a", "b", "c", "d"], min(0));
  const first = conversation(min(0), min(2));
  const second = conversation(min(2), min(4));
  expect(textsOf(first)).toEqual(["a", "b"]);
  expect(textsOf(second)).toEqual(["c", "d"]);
});

test("words are all there up to the first job still to transcribe", () => {
  const state = (jobId: string, s: "queued" | "submitted" | "failed") =>
    env.db
      .update(transcriptionJobs)
      .set({ state: s })
      .where(eq(transcriptionJobs.id, jobId))
      .run();
  const id = conversation(min(0), min(10));
  expect(loadTurns(env.db, id)?.pendingFrom).toBeNull();
  job(["a", "b"], min(0));
  state(job(["c"], min(1)), "failed");
  state(job(["d", "e"], min(4)), "submitted");
  state(job(["f"], min(3)), "queued");
  expect(loadTurns(env.db, id)?.pendingFrom).toBe(min(3));
});

// The cases the phone's TimeMap renders blocks by (Kit's TimelineTests read them too).
test("turn starts map to capture time as the phone laid the audio out", async () => {
  const fixture = await Bun.file(
    new URL("../../../fixtures/time-map.json", import.meta.url)
  ).json();
  const map = { segments: fixture.segments, separatorMs: fixture.separatorMs };
  const at = (ms: number) => captureMillis(map, ms / 1000);
  for (const p of fixture.points) {
    expect(at(p.prepared)).toBe(p.capture);
  }
  // Inside a separator: the next interval's start, where the phone has no instant.
  for (const p of fixture.inSeparator) {
    expect(at(p.prepared)).toBe(p.nextCapture);
  }
  for (const prepared of fixture.past) {
    expect(at(prepared)).toBeNull();
  }
  // The map's own separator moves everything after the first interval.
  expect(captureMillis({ ...map, separatorMs: 0 }, 1.1)).toBe(5100);
  expect(captureMillis({ ...map, separatorMs: 1000 }, 2.5)).toBe(5500);
});

test("bounded transcript windows read only their rows and retain stable progress", () => {
  job(["a", "b", "c", "d"], min(0));
  const id = conversation(min(0), min(4));
  const first = loadTurns(env.db, id, { limit: 2, offset: 0 });
  expect(first?.turns.map((t) => t.text)).toEqual(["a", "b"]);
  expect(first?.nextOffset).toBe(2);
  const second = loadTurns(env.db, id, {
    limit: 2,
    offset: first?.nextOffset ?? 0,
  });
  expect(second?.turns.map((t) => t.text)).toEqual(["c", "d"]);
  expect(
    loadTurns(env.db, id, { limit: 2, offset: second?.nextOffset ?? 0 })
      ?.nextOffset
  ).toBeNull();
});
