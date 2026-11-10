import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { clock } from "@life/server/src/core/clock";
import {
  conversations,
  namingAttempts,
  namingRollout,
  people,
  speakerAssignments,
  subscriptionUsage,
  transcripts,
} from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { NAMING, sha256Hex } from "./config";
import {
  isNamingGate,
  type NamingInput,
  namingPolicyHashOf,
  namingPromptHash,
} from "./inferred-speakers";
import { replaceLifePeople, resolveLifePerson } from "./life-people";
import { namingPass, readNamingInput } from "./naming-pass";
import { namingQuota, storeNamingGate } from "./naming-rollout";
import { assign } from "./people";
import type { ModelCall } from "./providers";
import { services } from "./services";
import {
  fakeModel,
  mapJob,
  seedConversation,
  testConfig,
  testDb,
} from "./testing";

const env = testDb();
afterAll(env.drop);
beforeEach(env.reset);
const originalCalibration = NAMING.calibration;
afterEach(() => {
  Object.assign(NAMING, { calibration: originalCalibration });
});
const calibration = {
  confidence: 0.99,
  contradictionMargin: 0.2,
  contradictionScore: 0.8,
};
function gateReceipt() {
  return {
    calibration,
    calibrationRecordingIds: ["calibration-recording"],
    callPredictions: 200,
    contextCallPredictions: 200,
    contextCorrect: 200,
    contextLowerBound: 0.981_154_673_6,
    contextPredictions: 200,
    contextRecordingPredictions: 200,
    correct: 200,
    datasetHash: "synthetic-dataset",
    heldOutRecordingIds: Array.from({ length: 200 }, (_, i) => `held-out-${i}`),
    inputHashes: Array.from({ length: 200 }, (_, i) => `synthetic-input-${i}`),
    lowerBound: 0.981_154_673_6,
    model: "test-codex",
    passed: true,
    policyHash: namingPolicyHashOf(),
    precision: 1,
    predictions: 200,
    promptHash: namingPromptHash(),
    recordingPredictions: 200,
  };
}
function calibratedGate() {
  Object.assign(NAMING, { calibration });
  const receipt = gateReceipt();
  storeNamingGate(env.db, receipt, receipt.model);
  return receipt;
}
const request = { engine: "codex", mode: "evaluation" as const };
function quota(age = 0) {
  const now = clock().getTime();
  env.db
    .insert(subscriptionUsage)
    .values({
      engine: "codex",
      reading: {
        fiveHour: { resetsAt: (now + 3_600_000) / 1000, usedPercent: 10 },
        observedAt: (now - age) / 1000,
        sevenDay: { resetsAt: (now + 86_400_000) / 1000, usedPercent: 20 },
      },
    })
    .onConflictDoUpdate({
      set: {
        reading: {
          fiveHour: { resetsAt: (now + 3_600_000) / 1000, usedPercent: 10 },
          observedAt: (now - age) / 1000,
          sevenDay: { resetsAt: (now + 86_400_000) / 1000, usedPercent: 20 },
        },
      },
      target: subscriptionUsage.engine,
    })
    .run();
}
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
  return seedConversation(env.db, [
    { end: 10, speakerId: "s", start: 0, text: "Hello Aster." },
  ]);
}
function abstention(call: ModelCall) {
  const context = JSON.parse(call.user) as NamingInput;
  return {
    readings: context.scopes.map((s) => ({
      confidence: 0,
      evidence: [],
      personId: null,
      scopeId: s.id,
    })),
  };
}
function model(respond: (call: ModelCall) => unknown = abstention) {
  const provider = fakeModel(respond);
  provider.name = "codex";
  provider.model = "test-codex";
  return provider;
}
const idleMac = () => ({
  able: () => true,
  idle: () => true,
  llm: () => Promise.reject(new Error("unexpected transport call")),
});

test("missing or stale quota, missing engine and non-Codex all pause without a call", async () => {
  seed();
  const provider = model();
  const queue = namingPass(env.db, idleMac(), provider);
  expect(await queue.run({ mode: "evaluation" })).toBe("off");
  expect(await queue.run({ engine: "claude", mode: "evaluation" })).toBe("off");
  expect(await queue.run(request)).toBe("paused");
  quota(NAMING.quotaMaxAgeMs + 1000);
  expect(namingQuota(env.db)).toBeNull();
  expect(await queue.run(request)).toBe("paused");
  expect(provider.calls).toHaveLength(0);
  expect(env.db.select().from(namingAttempts).all()).toEqual([]);
});

test("the idle socket view blocks queued, pending and foreign calls before model admission", async () => {
  seed();
  quota();
  const state = { foreign: 0, pending: 0, queued: 0 };
  const provider = model();
  const queue = namingPass(
    env.db,
    {
      ...idleMac(),
      idle: () => state.queued + state.pending + state.foreign === 0,
    },
    provider
  );
  for (const key of ["queued", "pending", "foreign"] as const) {
    state[key] = 1;
    // biome-ignore lint/performance/noAwaitInLoops: each socket state is checked before clearing it
    expect(await queue.run(request)).toBe("summaries_first");
    state[key] = 0;
  }
  expect(provider.calls).toHaveLength(0);
  expect(env.db.select().from(namingAttempts).get()?.attempts).toBe(0);
});

test("one in-flight naming call wins simultaneous requests and yields to a later summary", async () => {
  seed();
  quota();
  let release: (() => void) | undefined;
  let summaryPending = false;
  const provider = model(async (call) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return abstention(call);
  });
  const queue = namingPass(
    env.db,
    { ...idleMac(), idle: () => !summaryPending },
    provider
  );
  const first = queue.run(request);
  expect(provider.calls).toHaveLength(1);
  expect(await queue.run(request)).toBe("busy");
  summaryPending = true;
  release?.();
  expect(await first).toBe("abstained");
  seedConversation(
    env.db,
    [{ end: 10, speakerId: "s", start: 0, text: "A newer greeting." }],
    { at: Date.parse("2026-10-02T02:00:00Z") }
  );
  expect(await queue.run(request)).toBe("summaries_first");
  expect(provider.calls).toHaveLength(1);
});

test("gate, pilot and archive authorization guard assignment writes", async () => {
  seed();
  quota();
  const provider = model();
  const queue = namingPass(env.db, idleMac(), provider);
  expect(await queue.run({ engine: "codex", mode: "arrivals" })).toBe(
    "gate_required"
  );
  const { policyHash } = calibratedGate();
  expect(await queue.run({ engine: "codex", mode: "arrivals" })).toBe(
    "pilot_required"
  );
  env.db
    .update(namingRollout)
    .set({ pilotPassed: true })
    .where(eq(namingRollout.policyHash, policyHash))
    .run();
  expect(await queue.run({ engine: "codex", mode: "archive" })).toBe(
    "archive_authorization_required"
  );
  expect(provider.calls).toHaveLength(0);
  expect(env.db.select().from(speakerAssignments).all()).toEqual([]);
});

test("failed attempts persist due time and cap, while changed transcript input can run anew", async () => {
  const { id, jobId } = seed();
  quota();
  const provider = model(() => {
    throw new Error("model unavailable");
  });
  const queue = namingPass(env.db, idleMac(), provider);
  expect(readNamingInput(env.db, id)?.scopes).toHaveLength(1);
  expect(await queue.run(request)).toBe("failed");
  const old = env.db.select().from(namingAttempts).get();
  assert(old);
  expect(old).toMatchObject({
    attempts: 1,
    error: "model unavailable",
    state: "failed",
  });
  expect(old.nextEligibleAt?.getTime()).toBeGreaterThan(clock().getTime());
  expect(await queue.run(request)).toBe("advancing");
  expect(await queue.run(request)).toBe("idle");
  env.db
    .update(namingAttempts)
    .set({ attempts: NAMING.retryMaxAttempts, nextEligibleAt: null })
    .where(eq(namingAttempts.id, old.id))
    .run();
  expect(await queue.run(request)).toBe("idle");
  const stored = env.db
    .select()
    .from(transcripts)
    .where(eq(transcripts.jobId, jobId))
    .get();
  assert(stored);
  const [turn] = stored.parsed.turns;
  assert(turn);
  env.db
    .update(transcripts)
    .set({
      parsed: {
        ...stored.parsed,
        turns: [{ ...turn, text: "Changed greeting." }],
      },
    })
    .where(eq(transcripts.jobId, jobId))
    .run();
  mapJob(env.db, jobId, [
    [Date.parse("2026-10-01T02:00:00Z"), Date.parse("2026-10-01T02:10:00Z")],
  ]);
  expect(await queue.run(request)).toBe("failed");
  expect(provider.calls).toHaveLength(2);
  expect(
    env.db
      .select()
      .from(namingAttempts)
      .all()
      .map((a) => a.attempts)
      .sort()
  ).toEqual([1, NAMING.retryMaxAttempts].sort());
});

test("an invalid JSON response still records consumed tokens and becomes a failed attempt", async () => {
  seed();
  quota();
  const provider = model(() => "invalid JSON");
  const queue = namingPass(env.db, idleMac(), provider);
  expect(await queue.run(request)).toBe("failed");
  expect(env.db.select().from(namingAttempts).get()).toMatchObject({
    attempts: 1,
    call: { inputTokens: 1000, outputTokens: 100, text: "invalid JSON" },
    state: "failed",
  });
});

test("due failures retry only to the configured cap and then wait for input changes", async () => {
  seed();
  quota();
  const provider = model(() => {
    throw new Error("offline");
  });
  const queue = namingPass(env.db, idleMac(), provider);
  for (let count = 1; count <= NAMING.retryMaxAttempts; count += 1) {
    env.db
      .update(namingAttempts)
      .set({ nextEligibleAt: new Date(0) })
      .run();
    // biome-ignore lint/performance/noAwaitInLoops: one serialized retry is made eligible at a time
    expect(await queue.run(request)).toBe("failed");
    expect(env.db.select().from(namingAttempts).get()?.attempts).toBe(count);
  }
  env.db
    .update(namingAttempts)
    .set({ nextEligibleAt: new Date(0) })
    .run();
  expect(await queue.run(request)).toBe("advancing");
  expect(await queue.run(request)).toBe("idle");
  expect(provider.calls).toHaveLength(NAMING.retryMaxAttempts);
});

test("pilot caps count invalid calls including retries and retain both subscription windows", async () => {
  seed();
  quota();
  const provider = model(() => "invalid JSON");
  const { policyHash } = calibratedGate();
  env.db
    .update(namingRollout)
    .set({ pilotCalls: NAMING.pilotMaxCalls - 1 })
    .where(eq(namingRollout.policyHash, policyHash))
    .run();
  const queue = namingPass(env.db, idleMac(), provider);
  expect(await queue.run({ engine: "codex", mode: "pilot" })).toBe("failed");
  expect(env.db.select().from(namingRollout).get()).toMatchObject({
    inputTokens: 1000,
    longWindow: { after: { usedPercent: 20 }, before: { usedPercent: 20 } },
    outputTokens: 100,
    pilotCalls: NAMING.pilotMaxCalls,
    shortWindow: { after: { usedPercent: 10 }, before: { usedPercent: 10 } },
  });
  env.db
    .update(namingAttempts)
    .set({ nextEligibleAt: new Date(0) })
    .run();
  expect(await queue.run({ engine: "codex", mode: "pilot" })).toBe(
    "pilot_complete"
  );
  expect(provider.calls).toHaveLength(1);
  expect(env.db.select().from(speakerAssignments).all()).toEqual([]);
});

test("naming gates reject zero, insufficient, uncertain, leaking or mismatched measurements", () => {
  const withoutCalibration = gateReceipt();
  expect(isNamingGate(withoutCalibration, "test-codex")).toBe(false);
  const valid = calibratedGate();
  expect(isNamingGate(valid, "test-codex")).toBe(true);
  for (const changed of [
    { correct: 0, predictions: 0 },
    { contextCorrect: 0, contextPredictions: 0 },
    { predictions: NAMING.minimumGatePredictions - 1 },
    { contextPredictions: NAMING.minimumGatePredictions - 1 },
    { lowerBound: NAMING.precision - 0.01 },
    { contextLowerBound: NAMING.addedContextPrecision - 0.01 },
    { correct: 100 },
    { contextCorrect: 100 },
    { correct: 201 },
    { policyHash: "old-policy" },
    { promptHash: "old-prompt" },
    { model: "other-model" },
    { calibrationRecordingIds: ["held-out-0"] },
    { calibration: { ...calibration, confidence: 0.5 } },
  ]) {
    expect(isNamingGate({ ...valid, ...changed }, "test-codex")).toBe(false);
    expect(
      storeNamingGate(env.db, { ...valid, ...changed }, "test-codex")
    ).toBe(false);
  }
});

test("an inferred-created person confirmed by the owner remains eligible after snapshot removal", () => {
  const { jobId } = seed();
  const personId = resolveLifePerson(env.db, "life:person:aster");
  assert(personId);
  assign(env.db, {
    jobId,
    speakerLabel: "s",
    target: { kind: "person", personId },
    turnIndex: 0,
  });
  replaceLifePeople(env.db, {
    complete: true,
    folds: {},
    people: [],
    revision: 2,
    version: 1,
  });
  const next = seedConversation(
    env.db,
    [{ end: 10, speakerId: "s", start: 0, text: "Another greeting." }],
    { at: Date.parse("2026-10-02T02:00:00Z") }
  );
  expect(
    env.db.select().from(people).where(eq(people.id, personId)).get()
      ?.creationSource
  ).toBe("inferred");
  expect(
    readNamingInput(env.db, next.id)?.people.find(
      (p) => p.personId === personId
    )
  ).toMatchObject({ name: "Aster", personId });
});

test("passed pilots resume arrivals after quota reset while archive still requires authorization", async () => {
  const old = seed();
  quota();
  const { policyHash } = calibratedGate();
  const now = clock().getTime();
  const cutoff = now - 10_000;
  env.db
    .update(conversations)
    .set({ createdAt: new Date(cutoff - 1) })
    .where(eq(conversations.id, old.id))
    .run();
  const fresh = seedConversation(
    env.db,
    [{ end: 10, speakerId: "s", start: 0, text: "A new greeting." }],
    { at: Date.parse("2026-10-02T02:00:00Z") }
  );
  env.db
    .update(conversations)
    .set({ createdAt: new Date(cutoff + 1) })
    .where(eq(conversations.id, fresh.id))
    .run();
  const usage = env.db.select().from(subscriptionUsage).get();
  assert(usage);
  const reading = usage.reading as {
    fiveHour: { resetsAt: number; usedPercent: number };
    sevenDay: { resetsAt: number; usedPercent: number };
  };
  env.db
    .update(namingRollout)
    .set({
      createdAt: new Date(cutoff),
      inputTokens: 1000,
      latencyMs: 1000,
      longWindow: {
        after: { ...reading.sevenDay, resetsAt: now / 1000 - 1 },
        before: {
          ...reading.sevenDay,
          resetsAt: now / 1000 - 1,
          usedPercent: reading.sevenDay.usedPercent - 1,
        },
      },
      pilotCalls: NAMING.pilotMaxCalls,
      pilotPassed: true,
      shortWindow: {
        after: { ...reading.fiveHour, resetsAt: now / 1000 - 1 },
        before: {
          ...reading.fiveHour,
          resetsAt: now / 1000 - 1,
          usedPercent: reading.fiveHour.usedPercent - 1,
        },
      },
    })
    .where(eq(namingRollout.policyHash, policyHash))
    .run();
  const provider = model();
  const queue = namingPass(env.db, idleMac(), provider);
  expect(await queue.run({ engine: "codex", mode: "arrivals" })).toBe(
    "abstained"
  );
  expect(
    provider.calls.map(
      (call) => (JSON.parse(call.user) as NamingInput).conversationId
    )
  ).toEqual([fresh.id]);
  env.db
    .update(namingAttempts)
    .set({ updatedAt: new Date(now - 1_000_000) })
    .run();
  expect(await queue.run({ engine: "codex", mode: "arrivals" })).toBe(
    "advancing"
  );
  expect(await queue.run({ engine: "codex", mode: "arrivals" })).toBe(
    "advancing"
  );
  expect(await queue.run({ engine: "codex", mode: "arrivals" })).toBe("idle");
  expect(
    env.db
      .select()
      .from(namingAttempts)
      .all()
      .map((a) => a.conversationId)
  ).toEqual([fresh.id]);
  expect(
    await queue.run({
      archiveAuthorized: true,
      engine: "codex",
      mode: "archive",
    })
  ).toBe("abstained");
  expect(
    provider.calls.map(
      (call) => (JSON.parse(call.user) as NamingInput).conversationId
    )
  ).toEqual([fresh.id, old.id]);
});

test("an owner several-person fallback remains a candidate without becoming trusted presence", () => {
  seed();
  const fallback = env.db
    .insert(people)
    .values({ name: "Borin" })
    .returning()
    .get();
  assert(fallback);
  const conversation = seedConversation(
    env.db,
    [
      { end: 10, speakerId: "mixed", start: 0, text: "Several people here." },
      { end: 20, speakerId: "other", start: 10, text: "Who is speaking?" },
    ],
    { at: Date.parse("2026-10-03T02:00:00Z") }
  );
  assign(env.db, {
    jobId: conversation.jobId,
    speakerLabel: "mixed",
    target: {
      candidates: { people: [fallback.id], unknown: true },
      kind: "several",
      personId: fallback.id,
    },
    turnIndex: null,
  });
  const context = readNamingInput(env.db, conversation.id);
  assert(context);
  expect(context.people.find((p) => p.personId === fallback.id)).toBeDefined();
  expect(
    context.turns.find((t) => t.speakerLabel === "mixed")?.personId
  ).toBeNull();
  expect(context.ownerId).toBeNull();
  expect(context.scopes.some((s) => s.speakerLabel === "mixed")).toBe(false);
});

test("an authenticated passing receipt opens the pilot for only its measured model", async () => {
  seed();
  quota();
  Object.assign(NAMING, { calibration });
  const provider = model();
  const queue = namingPass(env.db, idleMac(), provider);
  const app = createApp(
    services(
      testConfig("http://localhost:1", {
        CORRECTIONS_TOKEN_HASH: sha256Hex("corrections"),
        READ_TOKEN_HASH: sha256Hex("read"),
      }),
      env.db,
      { intelligence: null, search: null }
    )
  );
  const receipt = gateReceipt();
  const install = (token: string, gate = receipt) =>
    app.request("/naming-gate", {
      body: JSON.stringify({ model: gate.model, receipt: gate }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
  expect(await queue.run({ engine: "codex", mode: "pilot" })).toBe(
    "gate_required"
  );
  expect((await install("read")).status).toBe(403);
  expect(
    (await install("corrections", { ...receipt, passed: false })).status
  ).toBe(400);
  expect((await install("corrections")).status).toBe(200);
  expect(await queue.run({ engine: "codex", mode: "pilot" })).toBe("abstained");
  env.db
    .update(namingRollout)
    .set({ pilotCalls: NAMING.pilotMaxCalls, pilotPassed: true })
    .where(eq(namingRollout.model, provider.model))
    .run();
  const other = model();
  other.model = "model-b";
  const otherQueue = namingPass(env.db, idleMac(), other);
  expect(await otherQueue.run({ engine: "codex", mode: "pilot" })).toBe(
    "gate_required"
  );
  expect(
    (await install("corrections", { ...receipt, model: "model-b" })).status
  ).toBe(200);
  expect(await otherQueue.run({ engine: "codex", mode: "arrivals" })).toBe(
    "pilot_required"
  );
  expect(other.calls).toHaveLength(0);
});
