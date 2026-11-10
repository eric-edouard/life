import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { people, speakerAssignments, voiceProfiles } from "@lifelog/db/schema";
import { createApp } from "./app";
import { sha256Hex } from "./config";
import { namingQueue } from "./naming-queue";
import { services } from "./services";
import { seedConversation, testConfig, testDb } from "./testing";

test("inferred turns without embeddings are visible and correctable through the map without teaching a voice", async () => {
  const env = testDb();
  const personId = randomUUID();
  env.db
    .insert(people)
    .values({ creationSource: "inferred", id: personId, name: "Guest" })
    .run();
  const { jobId } = seedConversation(env.db, [
    { end: 8, speakerId: "a", start: 0, text: "I am the guest." },
  ]);
  const inference = {
    attemptId: "synthetic-attempt",
    basis: "context" as const,
    confidence: 0.99,
    evidence: [{ jobId, quote: "I am the guest.", turnIndex: 0 }],
    inputHash: "synthetic-input",
    snapshotRevision: 1,
  };
  env.db
    .insert(speakerAssignments)
    .values({
      inference,
      jobId,
      personId,
      source: "inferred",
      speakerLabel: "a",
      status: "person",
      turnIndex: 0,
    })
    .run();
  const before = env.db.$client.serialize();
  const map = namingQueue(env.db).projection();
  expect(map.models).toEqual([]);
  expect(map.inferred).toEqual([
    {
      inference,
      jobId,
      personId,
      personName: "Guest",
      speakerLabel: "a",
      text: "I am the guest.",
      turnIndex: 0,
    },
  ]);
  expect(env.db.$client.serialize()).toEqual(before);
  const queue = namingQueue(env.db);
  const shown = queue.projection();
  const server = createApp(
    services(
      testConfig("http://localhost:1", {
        MAP_TOKEN_HASH: sha256Hex("map-token"),
      }),
      env.db,
      { intelligence: null, queue: { items: queue.items, map: () => shown } }
    )
  );
  const corrected = await server.request(`/transcripts/${jobId}/speakers/a`, {
    body: JSON.stringify({ target: { kind: "unknown" }, turnIndex: 0 }),
    headers: {
      Authorization: "Bearer map-token",
      "Content-Type": "application/json",
    },
    method: "PUT",
  });
  expect(corrected.status).toBe(200);
  expect(namingQueue(env.db).projection().inferred).toEqual([]);
  expect(env.db.select().from(voiceProfiles).all()).toEqual([]);
  env.drop();
});
