import { afterAll, beforeEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { clock } from "@life/server/src/core/clock";
import { namingRollout } from "@lifelog/db/schema";
import { NAMING } from "./config";
import { namingPilotPace } from "./naming-rollout";
import { testDb } from "./testing";

const env = testDb();
afterAll(env.drop);
beforeEach(env.reset);

test("pilot pace takes the slower subscription window and rejects missing, reset or unchanged readings", () => {
  const now = clock().getTime();
  const shortReset = (now + 3_600_000) / 1000;
  const longReset = (now + 86_400_000) / 1000;
  const rollout = env.db
    .insert(namingRollout)
    .values({
      inputTokens: 1000,
      latencyMs: 50_000,
      longWindow: {
        after: { resetsAt: longReset, usedPercent: 40 },
        before: { resetsAt: longReset, usedPercent: 20 },
      },
      model: "test-codex",
      pilotCalls: NAMING.pilotMaxCalls,
      policyHash: "pace",
      promptHash: "prompt",
      shortWindow: {
        after: { resetsAt: shortReset, usedPercent: 20 },
        before: { resetsAt: shortReset, usedPercent: 10 },
      },
    })
    .returning()
    .get();
  assert(rollout);
  const pace = namingPilotPace(rollout, now);
  expect(pace).toBe(
    (86_400_000 * 20) / (NAMING.pilotMaxCalls * (NAMING.quotaMaxPercent - 40))
  );
  for (const changed of [
    { shortWindow: null },
    { longWindow: null },
    { inputTokens: 0 },
    { latencyMs: 0 },
    { pilotCalls: NAMING.pilotMaxCalls - 1 },
    {
      shortWindow: {
        after: { resetsAt: shortReset, usedPercent: 20 },
        before: { resetsAt: shortReset, usedPercent: 20 },
      },
    },
    {
      longWindow: {
        after: { resetsAt: longReset + 1, usedPercent: 40 },
        before: { resetsAt: longReset, usedPercent: 20 },
      },
    },
    {
      longWindow: {
        after: { resetsAt: now / 1000, usedPercent: 40 },
        before: { resetsAt: now / 1000, usedPercent: 20 },
      },
    },
  ]) {
    expect(namingPilotPace({ ...rollout, ...changed }, now)).toBeNull();
  }
});

test("passed pilot measurements survive a quota reset and pace against fresh remaining quota", () => {
  const now = clock().getTime();
  const measurement = {
    after: { resetsAt: now / 1000 - 1, usedPercent: 20 },
    before: { resetsAt: now / 1000 - 1, usedPercent: 10 },
  };
  const rollout = env.db
    .insert(namingRollout)
    .values({
      inputTokens: 1000,
      latencyMs: 1000,
      longWindow: measurement,
      model: "model-a",
      pilotCalls: NAMING.pilotMaxCalls,
      pilotPassed: true,
      policyHash: "policy",
      promptHash: "prompt",
      shortWindow: measurement,
    })
    .returning()
    .get();
  assert(rollout);
  const fresh = {
    fiveHour: { resetsAt: (now + 3_600_000) / 1000, usedPercent: 1 },
    sevenDay: { resetsAt: (now + 86_400_000) / 1000, usedPercent: 2 },
  };
  expect(namingPilotPace(rollout, now, fresh)).toBe(
    (86_400_000 * 10) / (NAMING.pilotMaxCalls * (NAMING.quotaMaxPercent - 2))
  );
});

test("model and prompt changes cannot inherit another model's rollout", () => {
  env.db
    .insert(namingRollout)
    .values([
      {
        model: "model-a",
        pilotPassed: true,
        policyHash: "policy",
        promptHash: "prompt",
      },
      { model: "model-b", policyHash: "policy", promptHash: "prompt" },
      { model: "model-a", policyHash: "policy", promptHash: "new-prompt" },
    ])
    .run();
  expect(
    env.db
      .select()
      .from(namingRollout)
      .all()
      .map((r) => r.pilotPassed)
  ).toEqual([true, false, false]);
});
