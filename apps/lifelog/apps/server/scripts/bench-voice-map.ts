// Disposable synthetic archive only: bun apps/lifelog/apps/server/scripts/bench-voice-map.ts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  people,
  speakerAssignments,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { createApp } from "../src/app";
import { logChange } from "../src/change-log";
import { queueCache } from "../src/naming-cache";
import { namingQueue, readVoiceMap } from "../src/naming-queue";
import { services } from "../src/services";
import {
  OWNER_TOKEN,
  seedConversation,
  testConfig,
  testDb,
} from "../src/testing";

const dimensions = 192;
const conversations = 1000;
const perJob = 40;
const env = testDb();
const queue = queueCache(env.db);
const naming = namingQueue(env.db);
const owner = randomUUID();
let guest = owner;

function vectorOf(seed: number) {
  const vector = Array.from({ length: dimensions }, (_, d) =>
    Math.sin((seed + 1) * (d + 1))
  );
  const norm = Math.hypot(...vector);
  return vector.map((x) => x / norm);
}

function seedArchive() {
  env.db
    .insert(people)
    .values({ id: owner, isOwner: true, name: "Synthetic owner" })
    .run();
  for (let n = 0; n < conversations; n += 1) {
    env.db.transaction((tx) => {
      const { id, jobId } = seedConversation(
        tx,
        Array.from({ length: perJob }, (_, i) => ({
          end: (i + 1) * 10,
          speakerId: i % 2 ? "guest" : "owner",
          start: i * 10,
          text: "Synthetic archive speech.",
        })),
        { at: Date.parse("2026-01-01T00:00:00Z") + n * 3_600_000 }
      );
      tx.insert(speakerAssignments)
        .values([
          {
            jobId,
            personId: owner,
            source: "owner",
            speakerLabel: "owner",
            status: "person",
          },
          {
            candidateId: `group-${n}`,
            jobId,
            source: "recognized",
            speakerLabel: "guest",
            status: "candidate",
          },
          ...[37, 39].map((turnIndex) => ({
            candidateId: `split-${n}`,
            jobId,
            source: "recognized" as const,
            speakerLabel: "guest",
            status: "candidate" as const,
            turnIndex,
          })),
        ])
        .run();
      const rows = Array.from({ length: perJob }, (_, turnIndex) => ({
        conversationId: id,
        durationSeconds: 10,
        embedding: vectorOf(turnIndex % 2 ? n + 1 : 0),
        jobId,
        modelId: "synthetic-ecapa",
        modelRevision: "r1",
        speakerLabel: turnIndex % 2 ? "guest" : "owner",
        turnIndex,
      }));
      for (let i = 0; i < rows.length; i += 10) {
        tx.insert(voiceSamples)
          .values(rows.slice(i, i + 10))
          .run();
      }
    });
  }
  for (let person = 0; person < 30; person += 1) {
    const personId = person === 0 ? owner : randomUUID();
    if (person > 0) {
      env.db
        .insert(people)
        .values({ id: personId, name: `Synthetic person ${person}` })
        .run();
    }
    if (person === 1) {
      guest = personId;
    }
    for (let k = 0; k < 5; k += 1) {
      const { id, jobId } = seedConversation(
        env.db,
        [
          {
            end: 10,
            speakerId: "known",
            start: 0,
            text: "Synthetic known speech.",
          },
        ],
        {
          at: Date.parse("2025-01-01T00:00:00Z") + (person * 5 + k) * 3_600_000,
        }
      );
      env.db
        .insert(speakerAssignments)
        .values({
          jobId,
          personId,
          source: "owner",
          speakerLabel: "known",
          status: "person",
        })
        .run();
      const sample = env.db
        .insert(voiceSamples)
        .values({
          conversationId: id,
          durationSeconds: 10,
          embedding: vectorOf(person * 7 + k),
          jobId,
          modelId: "synthetic-ecapa",
          modelRevision: "r1",
          speakerLabel: "known",
          turnIndex: 0,
        })
        .returning()
        .get();
      assert(sample);
      env.db
        .insert(voiceProfiles)
        .values({ personId, sampleId: sample.id })
        .run();
    }
  }
}

function time<T>(read: () => T) {
  const start = performance.now();
  const value = read();
  return { ms: performance.now() - start, value };
}

// Keep the timer alive through delivery, JSON work and the following event-loop tick.
async function withStall<T extends object>(
  read: (started: number) => Promise<T>
) {
  let previous = performance.now();
  let maxStallMs = 0;
  const interval = setInterval(() => {
    const now = performance.now();
    maxStallMs = Math.max(maxStallMs, now - previous - 5);
    previous = now;
  }, 5);
  const started = performance.now();
  try {
    const result = await read(started);
    const ms = performance.now() - started;
    await Bun.sleep(10);
    return { ...result, maxStallMs, ms };
  } finally {
    clearInterval(interval);
  }
}

// Includes worker message delivery and the JSON serialization done by the GET route.
function readBuiltMap() {
  return withStall(async (started) => {
    let maxReadMs = 0;
    let reads = 0;
    let map: ReturnType<typeof queue.map>;
    do {
      const read = time(() => {
        const current = queue.map();
        if (current) {
          JSON.stringify(current);
        }
        return current;
      });
      map = read.value;
      maxReadMs = Math.max(maxReadMs, read.ms);
      reads += 1;
      assert(
        performance.now() - started < 60_000,
        "worker did not finish in 60 seconds"
      );
      // biome-ignore lint/performance/noAwaitInLoops: poll and let the interval observe the final read and serialization
      await Bun.sleep(10);
    } while (!map || map.building);
    return {
      cards: map.cards.length,
      maxReadMs,
      points: map.models[0]?.points.length,
      reads,
    };
  });
}

// Exercise the phone's real route without opening a port.
function readNamingQueue() {
  const app = createApp(
    services(testConfig("http://localhost:1"), env.db, {
      intelligence: null,
      queue,
    })
  );
  logChange(env.db, "person", guest);
  return withStall(async () => {
    const response = await app.request("/naming-queue", {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    });
    assert.equal(response.status, 200);
    const cards = await response.json();
    assert(Array.isArray(cards));
    assert.equal(cards.length, 1000);
    return { cards: cards.length };
  });
}

try {
  seedArchive();
  const built = time(() => naming.items());
  assert.equal(built.value.length, 1000);
  const mapOnlyMs = Array.from(
    { length: 3 },
    () => time(() => readVoiceMap(env.db, built.value)).ms
  );
  const projectionMs = Array.from(
    { length: 3 },
    () => time(() => naming.projection()).ms
  );
  const incrementalMs = Array.from({ length: 3 }, () => {
    logChange(env.db, "person", guest);
    return time(() => naming.projection()).ms;
  });
  const coldWorker = await readBuiltMap();
  assert.equal(coldWorker.cards, 2000);
  assert.equal(coldWorker.points, 2575);
  const warmWorker: (typeof coldWorker)[] = [];
  for (let i = 0; i < 3; i += 1) {
    logChange(env.db, "person", guest);
    // biome-ignore lint/performance/noAwaitInLoops: invalidate only after the preceding worker build completed
    warmWorker.push(await readBuiltMap());
  }
  const namingQueueRequest = await readNamingQueue();
  const cachedMs =
    time(() => {
      for (let i = 0; i < 100; i += 1) {
        JSON.stringify(queue.map());
      }
    }).ms / 100;
  console.log(
    JSON.stringify(
      {
        cachedWithJsonMs: cachedMs,
        coldWorker,
        conversations: conversations + 150,
        dimensions,
        incrementalMs,
        mapOnlyMs,
        namingQueueRequest,
        people: 30,
        projectionMs,
        queueMs: built.ms,
        samples: conversations * perJob + 150,
        warmWorker,
      },
      null,
      2
    )
  );
} finally {
  queue.close();
  env.drop();
}
