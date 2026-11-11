import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { clock } from "@life/server/src/core/clock";
import {
  conversations,
  people,
  speakerAssignments,
  voiceSamples,
} from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { evaluate, exportVoices } from "../scripts/eval-voices";
import { createApp } from "./app";
import { logChange } from "./change-log";
import { setOwnerTimeZone, sha256Hex } from "./config";
import { queueCache } from "./naming-cache";
import { answerVoices, morningPush, namingQueue } from "./naming-queue";
import { assign, keepServerSamples, recognize, weighProfiles } from "./people";
import { services } from "./services";
import { profilesWithout, soundsLikeOf } from "./speakers";
import { OWNER_TOKEN, seedConversation, testConfig, testDb } from "./testing";

const FIRST = [1, 0, 0];
const SECOND = [0, 1, 0];
const THIRD = [0, 0, 1];
const profiles = [FIRST, SECOND, THIRD].map((embedding, i) => ({
  conversations: ["elsewhere"],
  exemplars: [embedding],
  isOwner: false,
  personId: `person-${i}`,
}));

test("recheck uses first guesses, at half, and picks the most frequent other person", () => {
  const heard = (vectors: number[][], among = profiles) =>
    soundsLikeOf(vectors, "person-0", among);
  expect(heard([FIRST, SECOND])).toEqual({ personId: "person-1", share: 0.5 });
  expect(heard([FIRST, FIRST, SECOND])).toBeNull();
  expect(heard([SECOND, SECOND, THIRD])).toEqual({
    personId: "person-1",
    share: 1,
  });
  // The named person has no evidence elsewhere: nothing to compare with.
  expect(heard([SECOND], profiles.slice(1))).toBeNull();
  expect(heard([])).toBeNull();
  // The share of other people reaches half even when no single one does.
  expect(heard([FIRST, FIRST, SECOND, THIRD])?.personId).toBe("person-1");
});

test("profile filtering keeps aligned conversation centroids and matches rebuilding", () => {
  const row = (
    conversationId: string,
    personId: string,
    embedding: number[],
    durationSeconds = 5
  ) => ({
    conversationId,
    durationSeconds,
    embedding,
    isOwner: false,
    modelId: "test",
    modelRevision: "1",
    personId,
    sampleId: randomUUID(),
  });
  const evidence = [
    row("held", "first", FIRST),
    row("other", "first", FIRST),
    row("other", "first", SECOND),
    row("held", "second", SECOND),
    row("short", "second", SECOND, 1),
  ];
  const strangers = [
    row("held", "unknown", SECOND),
    row("other", "unknown", THIRD),
  ];
  const original = weighProfiles(evidence, strangers).get("test@1");
  if (!original) {
    throw new Error("missing profiles");
  }
  const before = structuredClone(original);
  const filtered = profilesWithout(original, new Set(["held"]));
  expect(
    weighProfiles(
      evidence.filter((r) => r.conversationId !== "held"),
      strangers.filter((r) => r.conversationId !== "held")
    ).get("test@1")
  ).toEqual(filtered);
  expect(filtered.people[0]?.conversations).toEqual(["other"]);
  expect(filtered.strangerConversations).toEqual(["other"]);
  expect(filtered.strangers).toEqual([THIRD]);
  expect(original).toEqual(before);
  expect(profilesWithout(original, new Set(["held", "other"])).people).toEqual(
    []
  );
});

let env: ReturnType<typeof testDb>;
let seeded = 0;
let cache: ReturnType<typeof queueCache> | null = null;
beforeAll(() => {
  env = testDb();
  setOwnerTimeZone("Etc/UTC");
});
beforeEach(() => {
  env.reset();
  seeded = 0;
});
afterEach(() => {
  cache?.close();
  cache = null;
});
afterAll(() => {
  setOwnerTimeZone(null);
  env.drop();
});

const person = (name: string, isOwner = false) => {
  const id = randomUUID();
  env.db.insert(people).values({ id, isOwner, name }).run();
  return id;
};
function voice(personId: string | null, vectors: number[][]) {
  seeded += 1;
  const held = seedConversation(
    env.db,
    vectors.map((_, i) => ({
      end: i * 10 + 8,
      speakerId: "voice",
      start: i * 10,
      text: "Made-up words.",
    })),
    { at: Date.parse("2026-10-01T00:00:00Z") + seeded * 600_000 }
  );
  keepServerSamples(
    env.db,
    held.jobId,
    vectors.map((embedding, turnIndex) => ({
      conversationId: held.id,
      durationSeconds: 8,
      embedding,
      jobId: held.jobId,
      modelId: "test",
      modelRevision: "1",
      speakerLabel: "voice",
      turnIndex,
    }))
  );
  if (personId) {
    assign(env.db, {
      jobId: held.jobId,
      speakerLabel: "voice",
      target: { kind: "person", personId },
      turnIndex: null,
    });
  }
  return held;
}
const rowOf = (jobId: string, turnIndex: number | null = null) =>
  env.db
    .select()
    .from(speakerAssignments)
    .where(eq(speakerAssignments.jobId, jobId))
    .all()
    .find((r) => r.turnIndex === turnIndex);
function setup() {
  person("Owner", true);
  const first = person("Ana");
  const second = person("Bo");
  voice(first, [FIRST, FIRST]);
  voice(second, [SECOND, SECOND]);
  return { first, second };
}

test("the existing answer settles either name, through the worker; push and map ignore rechecks", async () => {
  const { first, second } = setup();
  const same = voice(first, [FIRST, SECOND]);
  const changed = voice(first, [SECOND, SECOND]);
  cache = queueCache(env.db);
  const queue = cache;
  const config = testConfig("http://localhost:1", {
    CORRECTIONS_TOKEN_HASH: sha256Hex("corrector"),
    MAP_TOKEN_HASH: sha256Hex("map"),
    READ_TOKEN_HASH: sha256Hex("reader"),
  });
  const app = createApp(
    services(config, env.db, {
      intelligence: null,
      queue,
      voices: { nightly: () => null, soon: () => undefined },
    })
  );
  const headers = {
    Authorization: `Bearer ${OWNER_TOKEN}`,
    "Content-Type": "application/json",
  };
  const listed = await app.request("/naming-queue/rechecks", { headers });
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject([
    {
      clips: [expect.any(Object), expect.any(Object)],
      id: `${changed.jobId}/voice`,
      kind: "recheck",
      // Everyone with a voice, the most like this one first.
      likely: [second, first],
      namedPersonId: first,
      personId: second,
      seconds: 16,
    },
    {
      id: `${same.jobId}/voice`,
      kind: "recheck",
      namedPersonId: first,
      personId: second,
    },
  ]);
  expect(evaluate(exportVoices(env.db)).rechecks).toBe(2);
  expect(await queue.items()).toEqual([]);
  expect(queue.map()?.cards).toEqual([]);
  const at = clock();
  at.setUTCHours(12, 0, 0, 0);
  expect(await morningPush(env.db, null, "test", queue).morning(at)).toEqual({
    count: 0,
  });
  const refused = await Promise.all(
    ["reader", "corrector", "map"].map((token) =>
      app.request("/naming-queue/rechecks", {
        headers: { Authorization: `Bearer ${token}` },
      })
    )
  );
  expect(refused.map((response) => response.status)).toEqual([403, 403, 403]);
  for (const [held, personId] of [
    [same, first],
    [changed, second],
  ] as const) {
    expect(rowOf(held.jobId)?.rechecked).toBe(false);
    // biome-ignore lint/performance/noAwaitInLoops: each answer must publish its successor snapshot
    const response = await app.request("/naming-queue/answer", {
      body: JSON.stringify({
        answer: { kind: "assign", personId },
        voices: [{ jobId: held.jobId, speakerLabel: "voice" }],
      }),
      headers,
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(rowOf(held.jobId)).toMatchObject({ personId, rechecked: true });
    expect(
      (await queue.rechecks()).some((c) => c.id === `${held.jobId}/voice`)
    ).toBe(false);
  }
  expect(await queue.rechecks()).toEqual([]);
  const quiet = voice(null, [THIRD, THIRD]);
  const dismissed = await app.request("/naming-queue/answer", {
    body: JSON.stringify({
      answer: { kind: "not_relevant" },
      voices: [{ jobId: quiet.jobId, speakerLabel: "voice" }],
    }),
    headers,
    method: "POST",
  });
  expect(dismissed.status).toBe(200);
  expect(rowOf(quiet.jobId)?.status).toBe("not_relevant");
});

test("only owner replacement of the same scope sets the mark; recognition never does", () => {
  const { first } = setup();
  const held = voice(null, [FIRST, FIRST]);
  recognize(env.db, held.jobId);
  expect(rowOf(held.jobId)).toMatchObject({
    rechecked: false,
    source: "recognized",
  });
  const input = {
    jobId: held.jobId,
    speakerLabel: "voice",
    target: { kind: "person" as const, personId: first },
    turnIndex: null,
  };
  assign(env.db, input);
  expect(rowOf(held.jobId)?.rechecked).toBe(false);
  assign(env.db, { ...input, turnIndex: 0 });
  expect(rowOf(held.jobId, 0)?.rechecked).toBe(false);
  assign(env.db, { ...input, turnIndex: 0 });
  expect(rowOf(held.jobId, 0)?.rechecked).toBe(true);
  expect(rowOf(held.jobId)?.rechecked).toBe(false);
  assign(env.db, input);
  recognize(env.db, held.jobId);
  expect(rowOf(held.jobId)?.rechecked).toBe(true);
});

test("turn rows are excluded, retired conversations leave, and unchanged builds reuse cards", () => {
  const { first, second } = setup();
  const held = voice(first, [FIRST, SECOND, SECOND]);
  const queue = namingQueue(env.db);
  expect(queue.rechecks()).toHaveLength(1);
  expect(queue.rechecks()).toBe(queue.rechecks());
  assign(env.db, {
    jobId: held.jobId,
    speakerLabel: "voice",
    target: { kind: "person", personId: second },
    turnIndex: 1,
  });
  assign(env.db, {
    jobId: held.jobId,
    speakerLabel: "voice",
    target: { kind: "person", personId: second },
    turnIndex: 2,
  });
  expect(queue.rechecks()).toEqual([]);
  const retired = voice(first, [SECOND, SECOND]);
  expect(queue.rechecks()).toHaveLength(1);
  env.db
    .update(conversations)
    .set({ retiredAt: clock() })
    .where(eq(conversations.id, retired.id))
    .run();
  logChange(env.db, "conversation", retired.id);
  expect(queue.rechecks()).toEqual([]);
});

test("not relevant: never asked again, its voice kept, never a stranger's, nothing to score", () => {
  setup();
  const held = voice(null, [THIRD, THIRD]);
  const scored = evaluate(exportVoices(env.db)).turns;
  answerVoices(env.db, [{ jobId: held.jobId, speakerLabel: "voice" }], {
    kind: "not_relevant",
  });
  expect(rowOf(held.jobId)).toMatchObject({
    personId: null,
    source: "owner",
    status: "not_relevant",
  });
  expect(env.db.select().from(voiceSamples).all()).toHaveLength(6);
  expect(evaluate(exportVoices(env.db)).turns).toBe(scored);
  const again = voice(null, [THIRD, THIRD]);
  recognize(env.db, again.jobId);
  expect(rowOf(again.jobId)?.status).not.toBe("stranger");
});
