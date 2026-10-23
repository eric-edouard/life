// The archive check (archive-health.ts): every break it counts, and when it alerts.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  conversations,
  EMBEDDING_DIMENSIONS,
  events,
  people,
  searchPassages,
  speakerAssignments,
  speechFragments,
  type Turn,
  transcriptionJobs,
} from "@life/voice-db/schema";
import { eq, sql } from "drizzle-orm";
import { archiveHealth, healthWatch, worse } from "./archive-health";
import {
  seedConversation,
  seedTranscript,
  testConfig,
  testDb,
} from "./testing";

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

const turns: Turn[] = [
  { end: 4, speakerId: "speaker_0", start: 0, text: "Remember the plumber." },
  { end: 9, speakerId: "speaker_1", start: 5, text: "Monday at nine." },
];
const start = Date.parse("2026-10-01T02:00:00Z");
const seed = (at = start) => seedConversation(env.db, turns, { at });

const clean = {
  deadPassages: 0,
  overlaps: 0,
  pagesTwice: 0,
  strandedNames: 0,
  strayTurns: 0,
};

test("the archive check counts each break, and only a count that rose alerts", () => {
  const whole = seed();
  expect(archiveHealth(env.db)).toEqual(clean);
  // Two live conversations over the same minutes; a turn no live conversation holds.
  const twin = randomUUID();
  env.db
    .insert(conversations)
    .values({
      captureEndedAt: new Date(start + 60_000),
      captureStartedAt: new Date(start),
      id: twin,
    })
    .run();
  seedConversation(env.db, turns, { at: start + 3_600_000 });
  env.db.run(
    sql`update conversations set retired_at = ${Date.now()} where capture_started_at = ${start + 3_600_000}`
  );
  // A dead id's passage, and a name on a job nothing holds.
  env.db
    .insert(searchPassages)
    .values({
      capturedFrom: null,
      capturedTo: null,
      conversationId: randomUUID(),
      embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0),
      firstTurn: 0,
      jobId: whole.jobId,
      languageCode: "fra",
      lastTurn: 0,
      model: "m",
      personIds: [],
      speakers: [],
      text: "Monday at nine.",
      textHash: "h",
    })
    .run();
  const [person] = env.db
    .insert(people)
    .values({ name: "Hervé" })
    .returning()
    .all();
  env.db
    .insert(speakerAssignments)
    .values({
      jobId: seedTranscript(env.db, turns),
      personId: person?.id ?? null,
      source: "owner",
      speakerLabel: "speaker_1",
      status: "person",
    })
    .run();
  // Pages two jobs of a source hold (a failed one may share them), and two fragments.
  const holding = (pages: [number, number][], state = "completed") => {
    const id = seedTranscript(env.db, turns);
    env.db
      .update(transcriptionJobs)
      .set({ pages, sourceId: "dev1", state: state as "completed" })
      .where(eq(transcriptionJobs.id, id))
      .run();
  };
  holding([[10, 19]]);
  holding([
    [0, 9],
    [15, 30],
  ]);
  holding([[40, 50]], "failed");
  holding([[45, 46]]);
  const fragment = (pages: [number, number][]) => ({
    audioSha256: randomUUID(),
    captureEnd: new Date(start + 1000),
    captureStart: new Date(start),
    map: { segments: [], separatorMs: 400 },
    pages,
    sourceId: "dev1",
  });
  env.db
    .insert(speechFragments)
    .values([fragment([[100, 110]]), fragment([[105, 106]])])
    .run();
  const health = archiveHealth(env.db);
  expect(health).toEqual({
    deadPassages: 1,
    overlaps: 1,
    pagesTwice: 2,
    strandedNames: 1,
    strayTurns: 2,
  });
  expect(worse(health, health)).toEqual([]);
  expect(worse(health, { ...health, overlaps: 0 })).toEqual([["overlaps", 1]]);
});

test("the hourly check reads the last one back and records each", async () => {
  const watch = healthWatch(env.db, testConfig("http://localhost:1"));
  const at = Date.now();
  expect(await watch.hourly(at)).toEqual(clean);
  expect(await watch.hourly(at + 60_000)).toBeNull();
  expect(await watch.hourly(at + 3_600_000)).toEqual(clean);
  const checks = env.db
    .select()
    .from(events)
    .where(eq(events.name, "archive.checked"))
    .all();
  expect(checks).toHaveLength(2);
});
