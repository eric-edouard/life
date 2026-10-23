import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  conversations,
  quietRanges,
  speakerAssignments,
  type Turn,
  transcriptionJobs,
  transcripts,
  voiceSamples,
} from "@life/voice-db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { memoryAudioStore } from "./audio-store";
import { excerptSampler } from "./excerpts";
import { services } from "./services";
import {
  fakeSpeechService,
  mapJob,
  OWNER_TOKEN,
  oggOpus,
  seedTranscript,
  testConfig,
  testDb,
} from "./testing";

const speech = fakeSpeechService();
const audio = memoryAudioStore();
let env: Awaited<ReturnType<typeof testDb>>;
let sampler: ReturnType<typeof excerptSampler>;

beforeAll(() => {
  env = testDb();
  sampler = excerptSampler(
    env.db,
    testConfig("http://localhost:1", {
      IDENTITY_SECRET: "identity-test-secret",
      IDENTITY_URL: `http://localhost:${speech.server.port}`,
    }),
    audio
  );
});
afterAll(() => {
  env.drop();
  speech.server.stop(true);
});
beforeEach(() => {
  env.reset();
  seeded = 0;
  speech.busy = false;
  speech.ranges.length = 0;
});

// A unit vector along one axis.
const axis = (i: number) =>
  Array.from({ length: 192 }, (_, k) => (k === i ? 1 : 0));
const turn = (speakerId: string, start: number, end: number): Turn => ({
  end,
  speakerId,
  start,
  text: "…",
});

let seeded = 0;

// A block: a transcript with its audio in the bucket and its map, an hour after the one before.
// `grouped`: a conversation holds its turns by time (grouping), with no part naming the job.
function job(turns: Turn[], { grouped = true } = {}) {
  const at = Date.parse("2026-10-01T00:00:00Z") + seeded * 3_600_000;
  seeded += 1;
  const jobId = seedTranscript(env.db, turns);
  const objectKey = `blocks/test/${jobId}.ogg`;
  env.db
    .update(transcriptionJobs)
    .set({ objectKey, sourceId: "dev1" })
    .where(eq(transcriptionJobs.id, jobId))
    .run();
  audio.objects.set(objectKey, oggOpus(60));
  mapJob(env.db, jobId, [[at, at + 70_000]]);
  if (grouped) {
    env.db
      .insert(conversations)
      .values({
        captureEndedAt: new Date(at + 70_000),
        captureStartedAt: new Date(at),
        id: crypto.randomUUID(),
        sourceId: "dev1",
      })
      .run();
  }
  return jobId;
}

const jobRow = (id: string) => {
  const j = env.db.query.transcriptionJobs
    .findFirst({ where: eq(transcriptionJobs.id, id) })
    .sync();
  if (!j) {
    throw new Error(`no job ${id}`);
  }
  return j;
};
const samplesOf = (jobId: string) =>
  env.db.query.voiceSamples
    .findMany({
      orderBy: (s, { asc }) => asc(s.turnIndex),
      where: eq(voiceSamples.jobId, jobId),
    })
    .sync();
const cutAt = (jobId: string) =>
  env.db.query.transcripts
    .findFirst({
      where: eq(transcripts.jobId, jobId),
    })
    .sync()?.excerptsAt;

// Turn 1 is too short, 4 and 5 overlap; 2 is cut to its first 30 s.
const conversation = [
  turn("speaker_0", 0, 5),
  turn("speaker_1", 5, 6),
  turn("speaker_1", 6, 46),
  turn("speaker_0", 50, 55),
  turn("speaker_0", 60, 65),
  turn("speaker_1", 63, 68),
];

test("a block's clean turns are cut from its audio, once, and recognized, with no phone upload", async () => {
  const jobId = job(conversation);
  expect(await sampler.job(jobId)).toBe(3);
  expect(speech.ranges).toEqual([
    [
      [0, 5],
      [6, 36],
      [50, 55],
    ],
  ]);
  const stored = samplesOf(jobId);
  expect(stored.map((s) => [s.turnIndex, s.speakerLabel])).toEqual([
    [0, "speaker_0"],
    [2, "speaker_1"],
    [3, "speaker_0"],
  ]);
  expect(stored[1]?.durationSeconds).toBe(30);
  expect(cutAt(jobId)).toBeInstanceOf(Date);
  // Recognition ran: every speaker has a row.
  expect(
    env.db
      .select()
      .from(speakerAssignments)
      .all()
      .map((a) => a.speakerLabel)
      .sort()
  ).toEqual(["speaker_0", "speaker_1"]);

  // Nothing is cut or embedded twice.
  expect(await sampler.job(jobId)).toBe(0);
  expect(speech.ranges).toHaveLength(1);
});

test("a job waits for identity and for its conversation, and nothing is marked cut meanwhile", async () => {
  const jobId = job(conversation);
  speech.busy = true;
  expect(await sampler.job(jobId)).toBeNull();
  expect(cutAt(jobId)).toBeNull();
  speech.busy = false;

  const ungrouped = job(conversation, { grouped: false });
  expect(await sampler.job(ungrouped)).toBeNull();
  expect(cutAt(ungrouped)).toBeNull();

  // The tick picks up what is left.
  await sampler.pending();
  expect(cutAt(jobId)).toBeInstanceOf(Date);
  expect(cutAt(ungrouped)).toBeNull();
});

test("the live status says whether identity is set and how it last answered", async () => {
  const jobId = job(conversation);
  const away = excerptSampler(
    env.db,
    testConfig("http://localhost:1", {
      IDENTITY_SECRET: "identity-test-secret",
      IDENTITY_URL: "http://localhost:1",
    }),
    audio
  );
  expect(await away.job(jobId)).toBeNull();
  expect(away.identity()).toEqual({
    configured: true,
    lastError: expect.any(String),
    lastOkAt: null,
  });
  expect(await sampler.job(jobId)).toBe(3);
  expect(sampler.identity()).toEqual({
    configured: true,
    lastError: null,
    lastOkAt: expect.any(String),
  });
  const off = excerptSampler(env.db, testConfig("http://localhost:1"), audio);
  expect(off.identity().configured).toBe(false);
});

test("a job without bucket audio is left alone", async () => {
  const jobId = job(conversation);
  env.db
    .update(transcriptionJobs)
    .set({ objectKey: null })
    .where(eq(transcriptionJobs.id, jobId))
    .run();
  expect(await sampler.job(jobId)).toBe(0);
  expect(speech.ranges).toEqual([]);
  expect(samplesOf(jobId)).toEqual([]);
});

test("a turn the phone sampled keeps its sample", async () => {
  const jobId = job(conversation);
  env.db
    .insert(voiceSamples)
    .values({
      conversationId: crypto.randomUUID(),
      durationSeconds: 5,
      embedding: axis(9),
      jobId,
      modelId: "test/ecapa",
      modelRevision: "r1",
      speakerLabel: "speaker_0",
      turnIndex: 0,
    })
    .run();
  await sampler.job(jobId);
  const phone = (s: { embedding: number[] }) =>
    s.embedding.join() === axis(9).join();
  expect(samplesOf(jobId).map((s) => [s.turnIndex, phone(s)])).toEqual([
    [0, true],
    [2, false],
    [3, false],
  ]);
});

test("identity gets no audio a quiet range touches, nor an old job's", async () => {
  // The owner dictated to the Mac as turn 3 began (50 s into the block).
  const dictated = job(conversation);
  const at = jobRow(dictated).captureStart?.getTime() ?? 0;
  env.db
    .insert(quietRanges)
    .values({
      endedAt: new Date(at + 50_500),
      id: crypto.randomUUID(),
      source: "com.apple.dictation",
      startedAt: new Date(at + 49_500),
    })
    .run();
  // An old job whose audio the phone sent again: no quiet ranges before Oct 10.
  const old = job(conversation);
  env.db
    .update(transcriptionJobs)
    .set({ objectKey: `jobs/${old}.ogg` })
    .where(eq(transcriptionJobs.id, old))
    .run();
  audio.objects.set(`jobs/${old}.ogg`, oggOpus(60));
  expect([await sampler.job(dictated), await sampler.job(old)]).toEqual([0, 0]);
  expect(speech.ranges).toEqual([]);
  expect([cutAt(dictated), cutAt(old)]).toEqual([
    expect.any(Date),
    expect.any(Date),
  ]);
});

test("a job's bucket audio is served, by range too; a job without any is not found", async () => {
  const app = createApp(
    services(testConfig("http://localhost:1"), env.db, { audio })
  );
  const auth = { Authorization: `Bearer ${OWNER_TOKEN}` };
  const jobId = job(conversation);
  const whole =
    audio.objects.get(`blocks/test/${jobId}.ogg`) ?? new Uint8Array();

  const all = await app.request(`/transcripts/${jobId}/audio`, {
    headers: auth,
  });
  expect(all.status).toBe(200);
  expect(all.headers.get("Content-Type")).toBe("audio/ogg");
  expect(await all.bytes()).toEqual(new Uint8Array(whole));

  const part = await app.request(`/transcripts/${jobId}/audio`, {
    headers: { ...auth, Range: "bytes=4-11" },
  });
  expect(part.status).toBe(206);
  expect(part.headers.get("Content-Range")).toBe(`bytes 4-11/${whole.length}`);
  expect(await part.bytes()).toEqual(new Uint8Array(whole.slice(4, 12)));

  env.db
    .update(transcriptionJobs)
    .set({ objectKey: null })
    .where(eq(transcriptionJobs.id, jobId))
    .run();
  const none = await app.request(`/transcripts/${jobId}/audio`, {
    headers: auth,
  });
  expect(none.status).toBe(404);
});
