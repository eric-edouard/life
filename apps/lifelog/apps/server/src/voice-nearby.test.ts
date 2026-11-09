import { afterAll, beforeEach, expect, test } from "bun:test";
import { clock } from "@life/server/src/core/clock";
import {
  conversations,
  speakerAssignments,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  assign,
  expire,
  keepServerSamples,
  nearbyVoices,
  recognize,
  regroup,
  sweep,
  voiceUpkeep,
} from "./people";
import { mapJob, seedTranscript, testDb } from "./testing";

const env = testDb();
const { db } = env;
afterAll(() => env.drop());
beforeEach(() => env.reset());
const vector = (x: number, y: number, z = 0) => {
  const norm = Math.hypot(x, y, z);
  return [x / norm, y / norm, z / norm];
};
let day = 0;
const holder = () => {
  day += 1;
  return db
    .insert(conversations)
    .values({
      captureEndedAt: new Date(Date.UTC(2026, 0, day + 1)),
      captureStartedAt: new Date(Date.UTC(2026, 0, day)),
      id: crypto.randomUUID(),
    })
    .returning()
    .get().id;
};
function job(
  conversationId: string,
  vectors: number[][],
  hour = 0,
  revision = "r1"
) {
  const jobId = seedTranscript(
    db,
    vectors.map((_, i) => ({
      end: i * 10 + 10,
      speakerId: `speaker_${i}`,
      start: i * 10,
      text: "Some made up words",
    }))
  );
  const at =
    (db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()
      ?.captureStartedAt.getTime() ?? 0) +
    hour * 3_600_000;
  mapJob(db, jobId, [[at, at + vectors.length * 10_000]]);
  keepServerSamples(
    db,
    jobId,
    vectors.map((embedding, turnIndex) => ({
      conversationId,
      durationSeconds: 10,
      embedding,
      jobId,
      modelId: "test",
      modelRevision: revision,
      speakerLabel: `speaker_${turnIndex}`,
      turnIndex,
    }))
  );
  return jobId;
}
const row = (jobId: string, label = "speaker_0") =>
  db
    .select()
    .from(speakerAssignments)
    .where(
      and(
        eq(speakerAssignments.jobId, jobId),
        eq(speakerAssignments.speakerLabel, label),
        isNull(speakerAssignments.turnIndex)
      )
    )
    .get();
function enroll() {
  const enrolled = job(holder(), [[1, 0, 0]]);
  assign(db, {
    jobId: enrolled,
    speakerLabel: "speaker_0",
    target: { id: "known", kind: "new", name: "Morgan" },
    turnIndex: null,
  });
  return enrolled;
}

test("split voices use frozen direct matches in their own job, never gain evidence", () => {
  enroll();
  const id = job(holder(), [
    vector(1, 0.6),
    vector(0.5, 0.6, 0.3),
    vector(0.2, 0.5, 0.6),
  ]);
  recognize(db, id);
  expect(row(id)?.personId).toBe("known");
  expect(row(id, "speaker_1")?.personId).toBe("known");
  expect(row(id, "speaker_2")?.personId).toBeNull();
  expect(db.select().from(voiceProfiles).all()).toHaveLength(1);
});

test("same conversation references span hours, reject other conversations and model revisions", () => {
  enroll();
  const conversationId = holder();
  const direct = job(conversationId, [vector(1, 0.6)]);
  const missed = job(conversationId, [vector(0.5, 0.6, 0.3)], 8);
  const incompatible = job(conversationId, [vector(0.5, 0.6, 0.3)], 9, "r2");
  recognize(db, direct);
  recognize(db, missed);
  expect(row(missed)?.personId).toBe("known");
  recognize(db, incompatible);
  expect(row(incompatible)?.personId).toBeNull();
  // A standalone recording at the same instant is not a reference.
  const separate = holder();
  const outside = job(separate, [vector(0.5, 0.6, 0.3)]);
  recognize(db, outside);
  expect(row(outside)?.personId).toBeNull();
});

test("old samples stay negative references; media is deleted and an old unnamed voice is named by a sweep", async () => {
  const old = job(holder(), [[0, 1, 0]]);
  recognize(db, old);
  db.update(voiceSamples)
    .set({ createdAt: new Date(clock().getTime() - 90 * 86_400_000) })
    .run();
  expect(expire(db)).toBe(0);
  assign(db, {
    jobId: old,
    speakerLabel: "speaker_0",
    target: { kind: "unknown" },
    turnIndex: null,
  });
  expect(expire(db)).toBe(0);
  expect(nearbyVoices().read(db, old)).toEqual([]);
  expect(await regroup(db)).toBe(0);
  const unknown = job(holder(), [[1, 0, 0]]);
  recognize(db, unknown);
  enroll();
  await sweep(db);
  expect(row(unknown)?.personId).toBe("known");
  assign(db, {
    jobId: old,
    speakerLabel: "speaker_0",
    target: { kind: "media" },
    turnIndex: null,
  });
  expect(expire(db)).toBe(1);
});

test("a previous direct match cannot keep naming itself after its evidence changes", () => {
  const evidence = enroll();
  const id = job(holder(), [[1, 0, 0]]);
  recognize(db, id);
  expect(row(id)?.personId).toBe("known");
  db.update(voiceSamples)
    .set({ embedding: [0, 1, 0] })
    .where(eq(voiceSamples.jobId, evidence))
    .run();
  recognize(db, id);
  expect(row(id)?.personId).toBeNull();
});

test("presence from another embedding revision cannot break a profile tie", () => {
  enroll();
  const known = job(holder(), [[1, 0, 0]], 0, "r2");
  assign(db, {
    jobId: known,
    speakerLabel: "speaker_0",
    target: { kind: "person", personId: "known" },
    turnIndex: null,
  });
  const competing = job(holder(), [vector(0.9, Math.sqrt(0.19))], 0, "r2");
  assign(db, {
    jobId: competing,
    speakerLabel: "speaker_0",
    target: { id: "other", kind: "new", name: "Rowan" },
    turnIndex: null,
  });
  const conversationId = holder();
  const reference = job(conversationId, [[1, 0, 0]]);
  recognize(db, reference);
  const ambiguous = job(conversationId, [vector(1, 0.1)], 1, "r2");
  recognize(db, ambiguous);
  expect(row(ambiguous)?.personId).toBeNull();
});

test("upkeep queues another night while an earlier pass yields", async () => {
  const upkeep = voiceUpkeep(db);
  const first = upkeep.nightly(new Date("2026-01-01T04:00:00Z"));
  const second = upkeep.nightly(new Date("2026-01-02T04:00:00Z"));
  await Promise.all([first, second]);
  const nights = db.all<{ n: number }>(
    sql`select count(*) as n from events where name = 'voices.upkeep'`
  );
  expect(nights[0]?.n).toBe(2);
});
