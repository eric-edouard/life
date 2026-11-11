import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  conversations,
  transcriptionJobs,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { memoryAudioStore } from "./audio-store";
import { excerptSampler } from "./excerpts";
import { assign } from "./people";
import { dropOtherModels, reembed, reembedListing } from "./reembed";
import {
  fakeSpeechService,
  mapJob,
  oggOpus,
  seedTranscript,
  testConfig,
  testDb,
} from "./testing";

const speech = fakeSpeechService();
const audio = memoryAudioStore();
let env: Awaited<ReturnType<typeof testDb>>;
beforeAll(() => {
  env = testDb();
});
afterAll(() => {
  env.drop();
  speech.server.stop(true);
});

const NEW = { modelId: "test/new", modelRevision: "r2" };
const vector = Array.from({ length: 192 }, (_, i) => (i === 7 ? 1 : 0));

test("samples take the new model's vectors by id; the ones whose audio may not be heard go, with their evidence", async () => {
  const sampler = excerptSampler(
    env.db,
    testConfig("http://localhost:1", {
      IDENTITY_SECRET: "identity-test-secret",
      IDENTITY_URL: `http://localhost:${speech.server.port}`,
    }),
    audio
  );
  const turns = [
    { end: 5, speakerId: "speaker_0", start: 0, text: "…" },
    { end: 46, speakerId: "speaker_1", start: 6, text: "…" },
  ];
  const [block, old] = [0, 1].map((i) => {
    const at = Date.parse("2026-10-01T00:00:00Z") + i * 3_600_000;
    const jobId = seedTranscript(env.db, turns);
    const objectKey = `blocks/test/${jobId}.ogg`;
    env.db
      .update(transcriptionJobs)
      .set({ objectKey, sourceId: "dev1" })
      .where(eq(transcriptionJobs.id, jobId))
      .run();
    audio.objects.set(objectKey, oggOpus(60));
    mapJob(env.db, jobId, [[at, at + 70_000]]);
    env.db
      .insert(conversations)
      .values({
        captureEndedAt: new Date(at + 70_000),
        captureStartedAt: new Date(at),
        id: crypto.randomUUID(),
        sourceId: "dev1",
      })
      .run();
    return jobId;
  }) as [string, string];
  expect(await sampler.job(block)).toBe(2);
  expect(await sampler.job(old)).toBe(2);
  // The second job's audio came from the phone, before blocks: never heard again.
  env.db
    .update(transcriptionJobs)
    .set({ objectKey: "jobs/abc.ogg" })
    .where(eq(transcriptionJobs.id, old))
    .run();
  assign(env.db, {
    jobId: old,
    speakerLabel: "speaker_0",
    target: { id: crypto.randomUUID(), kind: "new", name: "Ada" },
    turnIndex: null,
  });
  expect(env.db.select().from(voiceProfiles).all()).toHaveLength(1);

  const listed = reembedListing(env.db, NEW);
  expect(listed.map((j) => [j.key, j.samples.map((s) => s.range)])).toEqual([
    [
      `blocks/test/${block}.ogg`,
      [
        [0, 5],
        [6, 36],
      ],
    ],
  ]);
  const ids = listed.flatMap((j) => j.samples.map((s) => s.id));
  expect(
    reembed(
      env.db,
      NEW,
      ids.map((id) => ({ embedding: vector, id }))
    )
  ).toBe(2);
  expect(reembedListing(env.db, NEW)).toEqual([]);

  const gone = dropOtherModels(env.db, NEW);
  expect([gone.dropped, Object.values(gone.lost)]).toEqual([2, [1]]);
  const left = env.db.select().from(voiceSamples).all();
  expect(left.map((s) => [s.jobId, s.modelId, s.embedding[7]])).toEqual([
    [block, "test/new", 1],
    [block, "test/new", 1],
  ]);
  expect(env.db.select().from(voiceProfiles).all()).toEqual([]);
});
