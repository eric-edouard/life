import { expect, test } from "bun:test";
import { exec } from "@life/server/src/core/proc";
import { speakerAssignments, voiceSamples } from "@lifelog/db/schema";
import { assign } from "./people";

import { regroup } from "./speaker-recognition";
import { seedTranscript, testDb } from "./testing";
import { averageLinkage, averageLinkageSync } from "./voice-linkage";
import { cosine, type Vector } from "./voice-vectors";

// Deliberately slow oracle: score every original pair again, without the production sums/cache.
function linkedByPairs(vectors: Vector[], threshold: number) {
  const groups: (number[] | null)[] = vectors.map((_, i) => [i]);
  for (;;) {
    let chosen: [number, number] | null = null;
    let score = threshold;
    for (let a = 0; a < groups.length; a += 1) {
      for (let b = a + 1; b < groups.length; b += 1) {
        const left = groups[a];
        const right = groups[b];
        if (!(left && right)) {
          continue;
        }
        const total = left.reduce(
          (sum, i) =>
            sum +
            right.reduce(
              (s, j) => s + cosine(vectors[i] ?? [], vectors[j] ?? []),
              0
            ),
          0
        );
        const alike = total / (left.length * right.length);
        if (alike >= score) {
          chosen = [a, b];
          score = alike;
        }
      }
    }
    if (!chosen) {
      return groups.filter((g): g is number[] => !!g);
    }
    const [a, b] = chosen;
    groups[a] = (groups[a] ?? []).concat(groups[b] ?? []);
    groups[b] = null;
  }
}

test("linkage sums preserve pair averages, ties and empty/singleton results", async () => {
  for (const vectors of [
    [],
    [[1, 0]],
    [
      [1, 0],
      [1, 0],
      [0, 1],
      [0, 1],
    ],
    [
      [1, 0],
      [0.6, 0.8],
      [0, 1],
    ],
    Array.from({ length: 18 }, (_, i) => {
      const angle = i * i * 1.234;
      return [Math.cos(angle), Math.sin(angle)];
    }),
  ]) {
    for (const threshold of [0.2, 0.6, 0.85, 1]) {
      expect(averageLinkageSync(vectors, threshold)).toEqual(
        linkedByPairs(vectors, threshold)
      );
      // biome-ignore lint/performance/noAwaitInLoops: each fixture is compared with the independent oracle
      expect(await averageLinkage(vectors, threshold)).toEqual(
        linkedByPairs(vectors, threshold)
      );
    }
  }
});

test("a large linkage scan yields and uses less than a dense matrix's memory", async () => {
  // Separate process: other suites' databases and allocations cannot inflate the measurement.
  const result = await exec([
    process.execPath,
    "--eval",
    `import { averageLinkage } from ${JSON.stringify(`${import.meta.dir}/voice-linkage.ts`)};
     const before = process.resourceUsage().maxRSS;
     let ticks = 0;
     const timer = setInterval(() => { ticks += 1; }, 0);
     const groups = await averageLinkage(Array.from({length: 6000}, () => [1, 0]), 1.1);
     clearInterval(timer);
     console.log(JSON.stringify({groups: groups.length, ticks,
       memoryKB: process.resourceUsage().maxRSS - before}));`,
  ]);
  expect(result.code).toBe(0);
  const measured = JSON.parse(result.stdout);
  expect(measured.groups).toBe(6000);
  expect(measured.ticks).toBeGreaterThan(0);
  // A 6000² matrix alone needs 275 MiB of doubles, before row-array overhead.
  expect(measured.memoryKB).toBeLessThan(64 * 1024);
});

test("a correction while linkage yields discards its obsolete groups", async () => {
  const env = testDb();
  try {
    const jobs = Array.from({ length: 2 }, () =>
      seedTranscript(env.db, [
        { end: 10, speakerId: "speaker_0", start: 0, text: "A made-up voice." },
      ])
    );
    for (const jobId of jobs) {
      env.db
        .insert(voiceSamples)
        .values({
          conversationId: crypto.randomUUID(),
          durationSeconds: 10,
          embedding: [1, 0],
          jobId,
          modelId: "test/voice",
          modelRevision: "r1",
          speakerLabel: "speaker_0",
          turnIndex: 0,
        })
        .run();
      env.db
        .insert(speakerAssignments)
        .values({
          jobId,
          source: "recognized",
          speakerLabel: "speaker_0",
          status: "unknown",
        })
        .run();
    }
    const pending = regroup(env.db);
    assign(env.db, {
      jobId: jobs[0] ?? "",
      speakerLabel: "speaker_0",
      target: { id: crypto.randomUUID(), kind: "new", name: "Morgan" },
      turnIndex: null,
    });
    expect(await pending).toBe(0);
    const rows = env.db.select().from(speakerAssignments).all();
    expect(rows.find((r) => r.jobId === jobs[0])?.source).toBe("owner");
    expect(rows.every((r) => r.candidateId === null)).toBe(true);
  } finally {
    env.drop();
  }
});

test("average linkage never chains two different voices through an equally similar middle voice", async () => {
  const a = [1, 0];
  const between = [Math.SQRT1_2, Math.SQRT1_2];
  const b = [0, 1];
  expect(await averageLinkage([a, between, b], 0.6)).toEqual([[0], [1, 2]]);
  expect(await averageLinkage([a, a, b, b], 0.6)).toEqual([
    [0, 1],
    [2, 3],
  ]);
});
