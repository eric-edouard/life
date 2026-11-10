import { afterAll, beforeEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { clock } from "@life/server/src/core/clock";
import { namingAttempts, subscriptionUsage } from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { NAMING } from "./config";
import type { NamingInput } from "./inferred-speakers";
import { replaceLifePeople } from "./life-people";
import { namingPass } from "./naming-pass";
import type { ModelCall } from "./providers";
import { fakeModel, seedConversation, testDb } from "./testing";

const env = testDb();
afterAll(env.drop);
beforeEach(env.reset);
const request = { engine: "codex", mode: "evaluation" as const };
const idleMac = {
  able: () => true,
  idle: () => true,
  llm: () => Promise.reject(new Error("unexpected model transport")),
};
function seed() {
  replaceLifePeople(env.db, {
    complete: true,
    folds: {},
    people: [
      { aliases: [], name: "Aster", personId: null, ref: "person:aster" },
    ],
    revision: 1,
    version: 1,
  });
  const now = clock().getTime();
  env.db
    .insert(subscriptionUsage)
    .values({
      engine: "codex",
      reading: {
        fiveHour: { resetsAt: (now + 3_600_000) / 1000, usedPercent: 10 },
        observedAt: now / 1000,
        sevenDay: { resetsAt: (now + 86_400_000) / 1000, usedPercent: 20 },
      },
    })
    .run();
  return seedConversation(
    env.db,
    Array.from({ length: NAMING.contextMaxScopes + 1 }, (_, index) => ({
      end: (index + 1) * 5,
      speakerId: "speaker",
      start: index * 5,
      text: `Synthetic turn ${index}.`,
    }))
  );
}
function abstain(call: ModelCall) {
  const input = JSON.parse(call.user) as NamingInput;
  return {
    readings: input.scopes.map((scope) => ({
      confidence: 0,
      evidence: [],
      personId: null,
      scopeId: scope.id,
    })),
  };
}
function provider(respond: (call: ModelCall) => unknown = abstain) {
  const fake = fakeModel(respond);
  fake.name = "codex";
  fake.model = "test-codex";
  return fake;
}
const attempts = () => env.db.select().from(namingAttempts).all();
const scopeCount = (attempt: typeof namingAttempts.$inferSelect) =>
  (attempt.result as { readings?: unknown[] } | null)?.readings?.length ?? 0;
function makeDue(id: string) {
  env.db
    .update(namingAttempts)
    .set({ nextEligibleAt: new Date(0) })
    .where(eq(namingAttempts.id, id))
    .run();
}

test("81 unchecked turns progress past a pending abstention and cached retries retain separate capped attempts", async () => {
  seed();
  const fake = provider();
  const queue = namingPass(env.db, idleMac, fake);
  const nextWork = async () => {
    let outcome = await queue.run(request);
    while (outcome === "advancing") {
      // biome-ignore lint/performance/noAwaitInLoops: advance bounded fixture windows until work or idle
      outcome = await queue.run(request);
    }
    return outcome;
  };
  expect(await nextWork()).toBe("abstained");
  const [first] = attempts();
  assert(first);
  expect(scopeCount(first)).toBe(NAMING.contextMaxScopes);
  expect(first.nextEligibleAt?.getTime()).toBeGreaterThan(clock().getTime());
  expect(await nextWork()).toBe("abstained");
  const second = attempts().find((attempt) => attempt.id !== first.id);
  assert(second);
  expect(scopeCount(second)).toBe(1);
  expect(fake.calls).toHaveLength(2);
  expect(await nextWork()).toBe("idle");
  for (const attempt of [first, second]) {
    for (
      let count = attempt.attempts + 1;
      count <= NAMING.retryMaxAttempts;
      count += 1
    ) {
      makeDue(attempt.id);
      // biome-ignore lint/performance/noAwaitInLoops: each persisted retry is made due in order
      expect(await nextWork()).toBe("abstained");
      expect(attempts().find((row) => row.id === attempt.id)?.attempts).toBe(
        count
      );
    }
  }
  expect(fake.calls).toHaveLength(2);
  expect(attempts().map((attempt) => attempt.attempts)).toEqual([
    NAMING.retryMaxAttempts,
    NAMING.retryMaxAttempts,
  ]);
  expect(attempts().every((attempt) => attempt.state === "abstained")).toBe(
    true
  );
  expect(await nextWork()).toBe("idle");
});

test("a failed first window reaching its cap cannot prevent the remaining turn from being called", async () => {
  seed();
  const fake = provider((call) => {
    const input = JSON.parse(call.user) as NamingInput;
    if (input.scopes.length === NAMING.contextMaxScopes) {
      throw new Error("first window failed");
    }
    return abstain(call);
  });
  const queue = namingPass(env.db, idleMac, fake);
  expect(await queue.run(request)).toBe("failed");
  const [first] = attempts();
  assert(first);
  for (let count = 1; count < NAMING.retryMaxAttempts; count += 1) {
    makeDue(first.id);
    // biome-ignore lint/performance/noAwaitInLoops: exhaust the first persisted work item's cap
    expect(await queue.run(request)).toBe("failed");
  }
  expect(attempts().find((attempt) => attempt.id === first.id)).toMatchObject({
    attempts: NAMING.retryMaxAttempts,
    error: "first window failed",
    state: "failed",
  });
  expect(await queue.run(request)).toBe("abstained");
  const remaining = attempts().find((attempt) => attempt.id !== first.id);
  assert(remaining);
  expect(scopeCount(remaining)).toBe(1);
  expect(fake.calls).toHaveLength(NAMING.retryMaxAttempts + 1);
  expect(
    (JSON.parse(fake.calls.at(-1)?.user ?? "{}") as NamingInput).scopes
  ).toHaveLength(1);
});
