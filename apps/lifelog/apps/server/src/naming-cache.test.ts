import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  mock,
  setSystemTime,
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
import { latestSeq, logChange } from "./change-log";
import { MAP_RETRY_DELAY, queueCache } from "./naming-cache";
import { namingQueue } from "./naming-queue";
import { assign, keepServerSamples } from "./people";

import { readVoices, recognize } from "./speaker-recognition";
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

const caches: ReturnType<typeof queueCache>[] = [];
const cache = () => {
  const queue = queueCache(env.db);
  caches.push(queue);
  return queue;
};
afterEach(async () => {
  for (const queue of caches.splice(0)) {
    queue.close();
  }
  await Bun.sleep(20);
});
async function ready(queue: ReturnType<typeof queueCache>) {
  for (let i = 0; i < 1000; i += 1) {
    const map = queue.map();
    if (map && !map.building) {
      return map;
    }
    // biome-ignore lint/performance/noAwaitInLoops: await the worker's snapshot
    await Bun.sleep(5);
  }
  throw new Error("Voice map worker did not finish");
}

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

test("the map is read-only and cached per queue build, then follows logged changes", async () => {
  const held = seed();
  const queue = cache();
  const before = env.db.$client.serialize();
  const first = await ready(queue);
  expect(first.cards).toHaveLength(1);
  expect(queue.map()).toEqual(first);
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
  const renamed = await ready(queue);
  expect(renamed).not.toBe(first);
  expect(renamed.people.some((p) => p.name === "Guest")).toBe(true);
  expect(queue.map()).toEqual(renamed);
  env.db
    .update(conversations)
    .set({ retiredAt: new Date("2026-10-02T00:00:00Z") })
    .where(eq(conversations.id, held.id))
    .run();
  logChange(env.db, "conversation", held.id);
  expect((await ready(queue)).cards).toEqual([]);
});

test("only the main label group is a phone card; recognized turn groups stay on the map", async () => {
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
  const queue = cache();
  const [card] = await queue.items();
  expect(await queue.items()).toHaveLength(1);
  expect(card?.voices).toEqual([
    { conversationId: held.id, jobId: held.jobId, speakerLabel: "guest" },
  ]);
  expect(card?.words).toBe(350);
  expect(card?.clips.map((c) => c.turnIndex)).toEqual([0]);
  expect((await ready(queue)).cards).toHaveLength(2);
});

test("new samples refresh the cached map even when an owner-named job needs no recognition change", async () => {
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
  const queue = cache();
  const before = await ready(queue);
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
  const after = await ready(queue);
  expect(after).not.toBe(before);
  expect(after.models[0]?.model).toBe("test@r1");
  expect(after.models[0]?.points.map((p) => p.personId)).toEqual([
    personId,
    personId,
  ]);
  expect(queue.map()).toEqual(after);
  keepServerSamples(env.db, held.jobId, [sample]);
  expect(queue.map()).toEqual(after);
});

test("one queue reader decodes a voice once and deduplicates repeated conversation references", () => {
  const { jobId } = seed();
  const reader = readVoices(env.db);
  const voice = { jobId, speakerLabel: "guest" };
  const first = reader.samples([voice]);
  expect(first).toHaveLength(2);
  const repeated = reader.samples([voice, voice]);
  expect(repeated).toEqual(first);
  expect(repeated[0]).toBe(first[0]);
  expect(reader.rank([voice, voice], null)).toHaveLength(2);
});

for (const retry of ["revision", "backoff", "write during build"] as const) {
  test(`failed rebuild rejects stale items and retries only after ${retry}`, async () => {
    seed();
    const workers: Worker[] = [];
    const originalWorker = globalThis.Worker;
    const spawn = mock(() => {
      const worker = Object.assign(new EventTarget(), {
        postMessage: mock(),
        terminate: mock(),
        unref: mock(),
      }) as unknown as Worker;
      workers.push(worker);
      return worker;
    });
    globalThis.Worker = spawn as unknown as typeof Worker;
    const now = clock().getTime();
    setSystemTime(now);
    try {
      const queue = cache();
      expect(queue.map()).toBeNull();
      const [firstWorker] = workers;
      if (!firstWorker) {
        throw new Error("missing worker");
      }
      const snapshot = namingQueue(env.db).projection();
      firstWorker.onmessage?.call(
        firstWorker,
        new MessageEvent("message", {
          data: { map: snapshot, seen: latestSeq(env.db) },
        })
      );
      const displayed = queue.map();
      expect(displayed).toEqual({ ...snapshot, building: false });
      expect(displayed).not.toBe(snapshot);
      logChange(env.db, "person", "changed");
      const items = queue.items();
      expect(queue.map()?.building).toBe(true);
      expect(displayed?.building).toBe(false);
      expect(snapshot).not.toHaveProperty("building");
      if (retry === "write during build") {
        logChange(env.db, "person", "newer");
      }
      firstWorker.onerror?.call(
        firstWorker,
        new ErrorEvent("error", { message: "failed rebuild" })
      );
      await expect(items).rejects.toThrow("could not build");
      if (retry !== "write during build") {
        for (let i = 0; i < 3; i += 1) {
          expect(queue.map()?.building).toBe(false);
        }
        await expect(queue.items()).rejects.toThrow("could not build");
        expect(spawn).toHaveBeenCalledTimes(1);
        setSystemTime(now + MAP_RETRY_DELAY - 1);
        queue.map();
        expect(spawn).toHaveBeenCalledTimes(1);
        if (retry === "revision") {
          logChange(env.db, "person", "newer");
        } else {
          setSystemTime(now + MAP_RETRY_DELAY);
        }
      }
      expect(queue.map()?.building).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(2);
      const [, nextWorker] = workers;
      if (!nextWorker) {
        throw new Error("missing replacement worker");
      }
      nextWorker.onerror?.call(
        nextWorker,
        new ErrorEvent("error", { message: "failed again" })
      );
      await expect(queue.items()).rejects.toThrow("could not build");
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.Worker = originalWorker;
      setSystemTime();
    }
  });
}
