import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  conversations,
  people,
  speakerAssignments,
  voiceSamples,
} from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { logChange } from "./change-log";
import { queueCache } from "./naming-queue";
import { assign, keepServerSamples, recognize } from "./people";
import { seedConversation, testDb } from "./testing";

let env: ReturnType<typeof testDb>;
beforeAll(() => {
  env = testDb();
});
beforeEach(() => {
  env.reset();
});
afterAll(() => {
  env.drop();
});

function seed() {
  env.db.insert(people).values({ isOwner: true, name: "Owner" }).run();
  const turns = [0, 1].map((i) => ({
    end: i * 10 + 9,
    speakerId: "guest",
    start: i * 10,
    text: "word ".repeat(350),
  }));
  const held = seedConversation(env.db, turns, {
    words: turns.flatMap((t) =>
      Array.from({ length: 350 }, (_, i) => ({
        ...t,
        end: t.start + (i + 1) / 100,
        logprob: null,
        spacing: " ",
        start: t.start + i / 100,
        text: "word",
      }))
    ),
  });
  env.db
    .insert(voiceSamples)
    .values(
      turns.map((_, turnIndex) => ({
        conversationId: held.id,
        durationSeconds: 9,
        embedding: [1, 0],
        jobId: held.jobId,
        modelId: "test",
        modelRevision: "r1",
        speakerLabel: "guest",
        turnIndex,
      }))
    )
    .run();
  return held;
}

test("the map is read-only and cached per queue build, then follows logged changes", () => {
  const held = seed();
  const queue = queueCache(env.db);
  const before = env.db.$client.serialize();
  const first = queue.map();
  expect(first.cards).toHaveLength(1);
  expect(queue.map()).toBe(first);
  expect(env.db.$client.serialize()).toEqual(before);
  const person = env.db
    .insert(people)
    .values({ name: "Guest" })
    .returning()
    .get();
  if (!person) {
    throw new Error("missing person");
  }
  logChange(env.db, "person", person.id);
  const renamed = queue.map();
  expect(renamed).not.toBe(first);
  expect(renamed.people.some((p) => p.name === "Guest")).toBe(true);
  expect(queue.map()).toBe(renamed);
  env.db
    .update(conversations)
    .set({ retiredAt: new Date("2026-10-02T00:00:00Z") })
    .where(eq(conversations.id, held.id))
    .run();
  expect(queue.map().cards).toEqual([]);
});

test("only the main label group is a phone card; recognized turn groups stay on the map", () => {
  const held = seed();
  env.db
    .insert(speakerAssignments)
    .values({
      candidateId: randomUUID(),
      jobId: held.jobId,
      source: "recognized",
      speakerLabel: "guest",
      status: "unknown",
      turnIndex: 1,
    })
    .run();
  const queue = queueCache(env.db);
  const [card] = queue.items();
  expect(queue.items()).toHaveLength(1);
  expect(card?.voices).toEqual([
    { conversationId: held.id, jobId: held.jobId, speakerLabel: "guest" },
  ]);
  expect(card?.words).toBe(350);
  expect(card?.clips.map((c) => c.turnIndex)).toEqual([0]);
  expect(queue.map().cards).toHaveLength(2);
});

test("new samples refresh the cached map even when an owner-named job needs no recognition change", () => {
  env.db.insert(people).values({ isOwner: true, name: "Owner" }).run();
  const held = seedConversation(env.db, [
    { end: 10, speakerId: "guest", start: 0, text: "Made-up speech." },
  ]);
  const personId = randomUUID();
  assign(env.db, {
    jobId: held.jobId,
    speakerLabel: "guest",
    target: { id: personId, kind: "new", name: "Guest" },
    turnIndex: null,
  });
  const queue = queueCache(env.db);
  const before = queue.map();
  expect(before.models).toEqual([]);
  expect(recognize(env.db, held.jobId)).toBe(false);
  const sample = {
    conversationId: held.id,
    durationSeconds: 10,
    embedding: [1, 0],
    jobId: held.jobId,
    modelId: "test",
    modelRevision: "r1",
    speakerLabel: "guest",
    turnIndex: 0,
  };
  keepServerSamples(env.db, held.jobId, [sample]);
  expect(recognize(env.db, held.jobId)).toBe(false);
  const after = queue.map();
  expect(after).not.toBe(before);
  expect(after.models[0]?.model).toBe("test@r1");
  expect(after.models[0]?.points.map((p) => p.personId)).toEqual([personId]);
  expect(queue.map()).toBe(after);
  keepServerSamples(env.db, held.jobId, [sample]);
  expect(queue.map()).toBe(after);
});
