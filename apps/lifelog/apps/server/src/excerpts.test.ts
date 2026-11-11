import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { migrateDb } from "@lifelog/db";
import {
  conversations,
  people,
  quietRanges,
  speakerAssignments,
  type Turn,
  transcriptionJobs,
  transcripts,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { memoryAudioStore } from "./audio-store";
import { excerptSampler } from "./excerpts";
import { assign } from "./people";
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

test("the one-time reopen recovers expired samples, preserves owner rows, and survives restart", async () => {
  const held = job(conversation);
  const ungrouped = job(conversation, { grouped: false });
  const noAudio = job(conversation);
  env.db
    .update(transcriptionJobs)
    .set({ objectKey: null })
    .where(eq(transcriptionJobs.id, noAudio))
    .run();
  env.db
    .update(transcripts)
    .set({ excerptsAt: new Date("2026-01-01") })
    .run();
  env.db
    .insert(voiceSamples)
    .values({
      conversationId: crypto.randomUUID(),
      durationSeconds: 5,
      embedding: axis(9),
      jobId: held,
      modelId: "test/ecapa",
      modelRevision: "r1",
      speakerLabel: "speaker_0",
      turnIndex: 0,
    })
    .run();
  env.db
    .insert(people)
    .values({ id: "test-owner", isOwner: true, name: "Owner" })
    .run();
  assign(env.db, {
    jobId: held,
    speakerLabel: "speaker_0",
    target: { kind: "person", personId: "test-owner" },
    turnIndex: null,
  });
  const ownerRows = env.db.select().from(speakerAssignments).all();
  // Restore the schema and journal as they were before this migration, on this disposable DB only.
  env.db.$client.run(
    "alter table transcripts drop column excerpts_attempted_at"
  );
  env.db.$client.run("alter table speaker_assignments drop column rechecked");
  // Its `when` in the journal: it and the migrations after it run again.
  env.db.$client.run(
    "delete from __drizzle_migrations where created_at >= 1794225727810"
  );
  migrateDb(env.db);
  expect(cutAt(held)).toBeNull();
  expect(cutAt(ungrouped)).toEqual(new Date("2026-01-01"));
  expect(cutAt(noAudio)).toEqual(new Date("2026-01-01"));
  await sampler.pending();
  expect(samplesOf(held).map((s) => s.turnIndex)).toEqual([0, 2, 3]);
  expect(samplesOf(held)[0]?.embedding).toEqual(axis(9));
  expect(
    env.db
      .select()
      .from(speakerAssignments)
      .all()
      .filter((a) => a.source === "owner")
  ).toEqual(ownerRows);
  expect(env.db.select().from(voiceProfiles).all()).toHaveLength(2);
  const finished = cutAt(held);
  migrateDb(env.db);
  expect(cutAt(held)).toEqual(finished);
  const restarted = excerptSampler(
    env.db,
    testConfig("http://localhost:1", {
      IDENTITY_SECRET: "identity-test-secret",
      IDENTITY_URL: `http://localhost:${speech.server.port}`,
    }),
    audio
  );
  await restarted.pending();
  expect(speech.ranges).toHaveLength(1);
});

test("failed old jobs yield to unattempted work, across sampler restarts", async () => {
  const jobs = Array.from({ length: 51 }, (_, i) => {
    const id = job([turn("speaker_0", 0, 5)]);
    env.db
      .update(transcripts)
      .set({ createdAt: new Date(i) })
      .where(eq(transcripts.jobId, id))
      .run();
    return id;
  });
  const ungrouped = job(conversation, { grouped: false });
  speech.busy = true;
  await sampler.pending();
  const attempts = env.db.select().from(transcripts).all();
  expect(attempts.filter((t) => t.excerptsAttemptedAt)).toHaveLength(50);
  expect(
    attempts.find((t) => t.jobId === jobs[50])?.excerptsAttemptedAt
  ).toBeNull();
  expect(
    attempts.find((t) => t.jobId === ungrouped)?.excerptsAttemptedAt
  ).toBeNull();
  speech.busy = false;
  const read: string[] = [];
  const restarted = excerptSampler(
    env.db,
    testConfig("http://localhost:1", {
      IDENTITY_SECRET: "identity-test-secret",
      IDENTITY_URL: `http://localhost:${speech.server.port}`,
    }),
    {
      ...audio,
      get: (key) => {
        read.push(key);
        return audio.get(key);
      },
    }
  );
  await restarted.pending();
  expect(read[0]).toBe(`blocks/test/${jobs[50]}.ogg`);
  expect(cutAt(jobs[50] ?? "")).toBeInstanceOf(Date);
});

test("two pending ticks never overlap a drain", async () => {
  job(conversation);
  job(conversation);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  const draining = excerptSampler(
    env.db,
    testConfig("http://localhost:1", {
      IDENTITY_SECRET: "identity-test-secret",
      IDENTITY_URL: `http://localhost:${speech.server.port}`,
    }),
    {
      ...audio,
      get: async (key) => {
        reads += 1;
        entered.resolve();
        await release.promise;
        return audio.get(key);
      },
    }
  );
  const first = draining.pending();
  await entered.promise;
  await draining.pending();
  expect(reads).toBe(1);
  release.resolve();
  await first;
  expect(reads).toBe(2);
  expect(speech.ranges).toHaveLength(2);
});

test("recovery leaves rejected voices alone, while sampling an unanswered turn", async () => {
  const id = job([
    turn("speaker_0", 0, 5),
    turn("speaker_1", 5, 10),
    turn("speaker_2", 10, 15),
    turn("speaker_3", 15, 20),
  ]);
  for (const [speakerLabel, status, source] of [
    ["speaker_0", "unknown", "owner"],
    ["speaker_1", "media", "owner"],
    ["speaker_2", "stranger", "recognized"],
  ] as const) {
    env.db
      .insert(speakerAssignments)
      .values({ jobId: id, source, speakerLabel, status })
      .run();
  }
  await sampler.pending();
  expect(samplesOf(id).map((s) => s.turnIndex)).toEqual([3]);
  expect(speech.ranges).toEqual([[[15, 20]]]);
});
