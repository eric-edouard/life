import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { connect, migrateDb } from "@lifelog/db";
import {
  diagnostics,
  people,
  speakerAssignments,
  voiceSamples,
} from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { logChange } from "./change-log";
import { sha256Hex } from "./config";
import { queueCache } from "./naming-cache";
import { services } from "./services";
import { OWNER_TOKEN, seedConversation, testConfig, testDb } from "./testing";

let env: ReturnType<typeof testDb>;
let queue: ReturnType<typeof queueCache>;
beforeEach(() => {
  env = testDb();
  queue = queueCache(env.db);
});
afterEach(async () => {
  queue.close();
  await Bun.sleep(20);
  env.drop();
});

async function until<T>(read: () => T | null | undefined) {
  for (let i = 0; i < 1000; i += 1) {
    const value = read();
    if (value) {
      return value;
    }
    // biome-ignore lint/performance/noAwaitInLoops: wait for the worker without opening a port
    await Bun.sleep(5);
  }
  throw new Error("Voice map worker did not finish");
}
const ready = () =>
  until(() => {
    const map = queue.map();
    return map && !map.building ? map : null;
  });
const headers = {
  Authorization: "Bearer made-up-map-token",
  "Content-Type": "application/json",
};
const app = () =>
  createApp(
    services(
      testConfig("http://localhost:1", {
        MAP_TOKEN_HASH: sha256Hex("made-up-map-token"),
      }),
      env.db,
      { intelligence: null, queue }
    )
  );

test("first map returns 202; refresh keeps the displayed map and accepts its remaining clip PUTs", async () => {
  env.db.insert(people).values({ isOwner: true, name: "Owner" }).run();
  const { id, jobId } = seedConversation(env.db, [
    { end: 12, speakerId: "a", start: 0, text: "Main voice" },
    { end: 24, speakerId: "a", start: 12, text: "First split turn" },
    { end: 36, speakerId: "a", start: 24, text: "Second split turn" },
  ]);
  env.db
    .insert(speakerAssignments)
    .values(
      [1, 2].map((turnIndex) => ({
        candidateId: "split",
        jobId,
        source: "recognized" as const,
        speakerLabel: "a",
        status: "candidate" as const,
        turnIndex,
      }))
    )
    .run();
  env.db
    .insert(voiceSamples)
    .values(
      [1, 2].map((turnIndex) => ({
        conversationId: id,
        durationSeconds: 12,
        embedding: [0, 1],
        jobId,
        modelId: "test",
        modelRevision: "r1",
        speakerLabel: "a",
        turnIndex,
      }))
    )
    .run();
  const server = app();
  const first = await server.request("/speakers/map", { headers });
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual({ building: true });
  const map = await ready();
  expect(map.cards).toHaveLength(1);
  expect(map.cards[0]?.clips.map((clip) => clip.turnIndex)).toEqual([1, 2]);
  const personId = randomUUID();
  for (const turnIndex of [1, 2]) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential owner answers must retain the displayed scope
    const response = await server.request(`/transcripts/${jobId}/speakers/a`, {
      body: JSON.stringify({
        target: { id: personId, kind: "new", name: "Guest" },
        turnIndex,
      }),
      headers,
      method: "PUT",
    });
    expect(response.status).toBe(200);
    const stale = queue.map();
    expect(stale?.building).toBe(true);
    expect(stale?.cards).toEqual(map.cards);
  }
  const refreshed = await ready();
  expect(refreshed.cards).toEqual([]);
  expect(
    env.db
      .select()
      .from(speakerAssignments)
      .all()
      .filter((row) => row.turnIndex !== null)
      .every((row) => row.source === "owner" && row.personId === personId)
  ).toBe(true);
});

test("concurrent phone and map reads share the worker snapshot and omit split cards from the phone", async () => {
  env.db.insert(people).values({ isOwner: true, name: "Owner" }).run();
  const { id, jobId } = seedConversation(
    env.db,
    [
      { end: 12, speakerId: "a", start: 0, text: "word ".repeat(350) },
      { end: 24, speakerId: "a", start: 12, text: "Split voice" },
    ],
    {
      words: Array.from({ length: 350 }, (_, i) => ({
        end: (i + 1) / 100,
        logprob: null,
        spacing: " ",
        speakerId: "a",
        start: i / 100,
        text: "word",
      })),
    }
  );
  env.db
    .insert(speakerAssignments)
    .values({
      candidateId: "split",
      jobId,
      source: "recognized",
      speakerLabel: "a",
      status: "candidate",
      turnIndex: 1,
    })
    .run();
  env.db
    .insert(voiceSamples)
    .values(
      [0, 1].map((turnIndex) => ({
        conversationId: id,
        durationSeconds: 12,
        embedding: [1, 0],
        jobId,
        modelId: "test",
        modelRevision: "r1",
        speakerLabel: "a",
        turnIndex,
      }))
    )
    .run();
  const server = app();
  const phoneHeaders = { Authorization: `Bearer ${OWNER_TOKEN}` };
  const phone = server.request("/naming-queue", { headers: phoneHeaders });
  const [first, items, second] = await Promise.all([
    server.request("/speakers/map", { headers }),
    queue.items(),
    server.request("/naming-queue", { headers: phoneHeaders }),
  ]);
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual({ building: true });
  const response = await phone;
  expect(response.status).toBe(200);
  expect(second.status).toBe(200);
  expect(await response.json()).toEqual(items);
  expect(await second.json()).toEqual(items);
  expect(items).toHaveLength(1);
  expect(items[0]?.clips.map((clip) => clip.turnIndex)).toEqual([0]);
  const map = queue.map();
  expect(map?.building).toBe(false);
  expect(map?.cards).toHaveLength(2);
  expect(map?.cards.map((card) => card.scope)).toEqual(["speaker", "turns"]);
  expect(
    map?.cards
      .filter((card) => card.scope === "speaker")
      .map(({ scope: _, ...card }) => card)
  ).toEqual(items);
});

test("a failed worker reports the error, preserves the last map and retries after repair", async () => {
  const owner = randomUUID();
  env.db
    .insert(people)
    .values({ id: owner, isOwner: true, name: "Owner" })
    .run();
  const original = await ready();
  env.db.$client.run("alter table voice_profiles rename to broken_profiles");
  logChange(env.db, "person", owner);
  expect(queue.map()?.building).toBe(true);
  const waitingItems = queue.items();
  await until(() => env.db.select().from(diagnostics).get());
  expect(await waitingItems).toEqual([]);
  env.db.$client.run("alter table broken_profiles rename to voice_profiles");
  env.db
    .update(people)
    .set({ name: "Renamed owner" })
    .where(eq(people.id, owner))
    .run();
  logChange(env.db, "person", owner);
  expect(queue.map()?.people).toEqual(original.people);
  const repaired = await ready();
  expect(repaired.people.find((person) => person.id === owner)?.name).toBe(
    "Renamed owner"
  );
  queue.close();
});

test("synchronous worker setup failure never leaves queue readers waiting", async () => {
  const db = connect(":memory:");
  migrateDb(db);
  const cache = queueCache(db);
  try {
    await expect(cache.items()).rejects.toThrow("file-backed archive");
    await expect(cache.items()).rejects.toThrow("file-backed archive");
  } finally {
    cache.close();
    db.$client.close(true);
  }
});
