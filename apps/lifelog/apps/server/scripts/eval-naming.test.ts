import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { clock } from "@life/server/src/core/clock";
import {
  lifePeopleSnapshot,
  namingAttempts,
  people,
  speakerAssignments,
  subscriptionUsage,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { NAMING } from "../src/config";
import {
  isNamingGate,
  type NamingInput,
  namingPolicyHashOf,
  namingPromptHash,
  namingWorkHash,
} from "../src/inferred-speakers";
import { namingPass } from "../src/naming-pass";
import { fakeModel, seedConversation, testDb } from "../src/testing";
import {
  type FrozenNamingEvaluation,
  freezeNamingCase,
  readNamingEvaluation,
} from "./eval-voices";

const HIM = [1, 0, 0];
const PAT = [0, 1, 0];
// Frozen naming replays use made-up SQLite data and cached replies only.
const calibration = {
  confidence: 0.98,
  contradictionMargin: 0.15,
  contradictionScore: 0.65,
};
function frozenFixture(
  withSamples = false,
  turnCount = 2,
  abstain = false,
  env = testDb()
) {
  const at = clock().getTime() + 86_400_000;
  env.db
    .insert(people)
    .values([
      { id: "owner", isOwner: true, name: "Owner" },
      { id: "guest", lifeRef: "person:guest", name: "Guest" },
    ])
    .run();
  env.db
    .insert(lifePeopleSnapshot)
    .values({
      folds: {},
      hash: "synthetic",
      people: [
        {
          aliases: [],
          name: "Guest",
          personId: "guest",
          ref: "person:guest",
        },
      ],
      revision: 1,
    })
    .run();
  const held = seedConversation(
    env.db,
    Array.from({ length: turnCount }, (_, index) => ({
      end: index * 6 + 5,
      speakerId: "s",
      start: index * 6,
      text: index === 0 ? "I am Guest." : "We can talk here.",
    })),
    { at: at - 600_000, ms: 600_000 }
  );
  const calibrated = seedConversation(
    env.db,
    [{ end: 5, speakerId: "s", start: 0, text: "A calibration conversation." }],
    { at: at - 1_200_000, ms: 600_000 }
  );

  if (withSamples) {
    const samples = env.db
      .insert(voiceSamples)
      .values(
        [0, 1].map((turnIndex) => ({
          conversationId: held.id,
          durationSeconds: 5,
          embedding: PAT,
          jobId: held.jobId,
          modelId: "ecapa",
          modelRevision: "1",
          speakerLabel: "s",
          turnIndex,
        }))
      )
      .returning()
      .all();
    env.db
      .insert(voiceProfiles)
      .values(samples.map((s) => ({ personId: "guest", sampleId: s.id })))
      .run();
    env.db
      .insert(speakerAssignments)
      .values({
        jobId: held.jobId,
        personId: "guest",
        source: "owner",
        speakerLabel: "s",
        status: "person",
      })
      .run();
  }
  const metadata = {
    calibration,
    model: "synthetic-codex",
    policyHash: namingPolicyHashOf(),
    promptHash: namingPromptHash(),
    snapshots: {},
  };
  const heldCase = freezeNamingCase(env.db, metadata, {
    answers: Array.from({ length: turnCount }, (_, turnIndex) => ({
      jobId: held.jobId,
      personId: "guest",
      speakerLabel: "s",
      turnIndex,
    })),
    at,
    conversationId: held.id,
    identityEvidence: ["owner", "guest"].map((personId) => ({
      at: at - 2_000_000,
      personId,
      recordingIds: [],
    })),
    partition: "held-out",
  });
  const calCase = freezeNamingCase(env.db, metadata, {
    answers: [
      {
        jobId: calibrated.jobId,
        personId: null,
        speakerLabel: "s",
        turnIndex: 0,
      },
    ],
    archiveHash: heldCase.archiveHash,
    at: at - 600_000,
    conversationId: calibrated.id,
    identityEvidence: ["owner", "guest"].map((personId) => ({
      at: at - 2_000_000,
      personId,
      recordingIds: [],
    })),
    partition: "calibration",
  });
  assert(heldCase.input);
  const raw = JSON.stringify({
    readings: heldCase.input.scopes.map((scope) => ({
      confidence: 0.99,
      evidence: abstain ? [] : [{ quote: "I am Guest.", turn: 0 }],
      personId: abstain ? null : "guest",
      scopeId: scope.id,
    })),
  });
  const attemptId = `synthetic-${held.jobId}`;
  env.db
    .insert(namingAttempts)
    .values({
      call: { inputTokens: 10, outputTokens: 10, text: raw },
      conversationId: held.id,
      id: attemptId,
      inputHash: namingWorkHash(heldCase.inputHash ?? "", metadata.model),
      model: metadata.model,
      policyHash: metadata.policyHash,
      promptHash: metadata.promptHash,
      result: { readings: JSON.parse(raw).readings },
      snapshotRevision: 1,
      state: abstain ? "abstained" : "named",
    })
    .run();
  const named = freezeNamingCase(env.db, metadata, {
    ...heldCase,
    archiveHash: undefined,
    attemptId,
  });
  delete metadata.snapshots[
    heldCase.archiveHash as keyof typeof metadata.snapshots
  ];
  const data: FrozenNamingEvaluation = {
    ...metadata,
    cases: [{ ...calCase, archiveHash: named.archiveHash }, named],
  };
  return { ...env, at, data, held };
}
test("frozen naming replays production decisions and reconciliation, reports context-only/short strata and never writes its source", () => {
  const env = frozenFixture();
  try {
    const before = env.db.$client.serialize();
    const report = readNamingEvaluation(env.data);
    expect(report.overall).toMatchObject({
      correct: 2,
      coverage: 1,
      precision: 1,
      predictions: 2,
    });
    expect(report.addedContext.predictions).toBe(2);
    expect(report.baseline.predictions).toBe(0);
    expect(report.strata.contextOnly.predictions).toBe(2);
    expect(report.strata.short.turns).toBe(2);
    expect([
      report.receipt.inputHashes.length,
      report.receipt.datasetHash.length,
    ]).toEqual([1, 64]);
    expect(report.receipt.lowerBound).toBeLessThan(0.98);
    expect(report.receipt.passed).toBe(false);
    expect(env.db.$client.serialize()).toEqual(before);
  } finally {
    env.drop();
  }
});
test("held-out owner answers and same-recording profile evidence never supply identity or presence", () => {
  const env = frozenFixture(true);
  try {
    const report = readNamingEvaluation(env.data);
    expect(report.baseline.predictions).toBe(0);
    expect(report.addedContext).toMatchObject({ correct: 2, predictions: 2 });
    expect(report.strata.contextOnly.turns).toBe(0);
  } finally {
    env.drop();
  }
});
test("zero predictions, overlapping partitions, stale metadata and changed cached input cannot authorize writes", () => {
  const env = frozenFixture();
  try {
    const abstained = frozenFixture(false, 2, true);
    const empty = readNamingEvaluation(abstained.data);
    abstained.drop();
    expect(empty.receipt.predictions).toBe(0);
    expect(empty.receipt.precision).toBeNull();
    expect(empty.receipt.passed).toBe(false);
    const overlap = readNamingEvaluation({
      ...env.data,
      cases: env.data.cases.map((c) => ({
        ...c,
        recordings: c.recordings.map((r) => ({
          ...r,
          recordingId: "same-recording",
        })),
      })),
    });
    expect(overlap.reasons).toContain(
      "calibration and held-out recordings or conversations overlap"
    );
    const stale = readNamingEvaluation({ ...env.data, promptHash: "old" });
    expect(stale.reasons).toContain(
      "model policy, prompt or calibrated cutoffs differ"
    );
    const changed = readNamingEvaluation({
      ...env.data,
      cases: env.data.cases.map((c) =>
        c.partition === "held-out" ? { ...c, inputHash: "changed" } : c
      ),
    });
    expect(changed.reasons.some((r) => r.includes("input hash mismatch"))).toBe(
      true
    );
  } finally {
    env.drop();
  }
});
test("future voice evidence and future candidate snapshots are refused before frozen reads are scored", () => {
  const env = frozenFixture(true);
  try {
    const samples = env.db.select().from(voiceSamples).all();
    const [first] = samples;
    assert(first);

    env.db
      .update(lifePeopleSnapshot)
      .set({ updatedAt: new Date(env.at + 1000) })
      .run();
    expect(() =>
      freezeNamingCase(env.db, env.data, {
        answers: [
          {
            jobId: env.held.jobId,
            personId: "guest",
            speakerLabel: "s",
            turnIndex: 0,
          },
        ],
        at: env.at,
        conversationId: env.held.id,
        identityEvidence: ["owner", "guest"].map((personId) => ({
          at: env.at - 10_000,
          personId,
          recordingIds: [],
        })),
        partition: "held-out",
      })
    ).toThrow("historical candidate snapshot");
  } finally {
    env.drop();
  }
});
test("many turns from only four calls cannot pass the independent Wilson gate", () => {
  const previous = NAMING.calibration;
  Object.assign(NAMING, { calibration });
  const fixtures: ReturnType<typeof frozenFixture>[] = [];
  try {
    for (let i = 0; i < 4; i += 1) {
      fixtures.push(frozenFixture(false, 50));
    }
    const [first] = fixtures;
    assert(first);
    const report = readNamingEvaluation({
      ...first.data,
      cases: fixtures.flatMap((f) => f.data.cases),
      snapshots: Object.assign({}, ...fixtures.map((f) => f.data.snapshots)),
    });
    expect(report.receipt.predictions).toBe(200);
    expect(report.receipt.contextPredictions).toBe(200);
    expect(report.receipt.lowerBound).toBeLessThan(NAMING.precision);
    expect(report.receipt.contextLowerBound).toBeLessThan(
      NAMING.addedContextPrecision
    );
    expect(report.receipt.recordingPredictions).toBe(4);
    expect(report.receipt.callPredictions).toBe(4);
    expect(report.receipt.passed).toBe(false);
  } finally {
    for (const fixture of fixtures) {
      fixture.drop();
    }
    Object.assign(NAMING, { calibration: previous });
  }
});

function freezeVoiceCase(
  vectors: number[][],
  labels: string[],
  answers: (string | null)[],
  several = false,
  future = false,
  onlyGuest = false
) {
  const env = frozenFixture();
  const profiles = seedConversation(
    env.db,
    [
      { end: 10, speakerId: "p", start: 0, text: "Earlier profile evidence." },
      {
        end: 20,
        speakerId: "q",
        start: 10,
        text: "Other earlier profile evidence.",
      },
    ],
    { at: future ? env.at + 1_800_000 : env.at - 2_400_000, ms: 600_000 }
  );
  env.db.insert(people).values({ id: "other", name: "Other guest" }).run();
  const taught = env.db
    .insert(voiceSamples)
    .values(
      [HIM, PAT].map((embedding, turnIndex) => ({
        conversationId: profiles.id,
        durationSeconds: 10,
        embedding,
        jobId: profiles.jobId,
        modelId: "test",
        modelRevision: "r1",
        speakerLabel: turnIndex ? "q" : "p",
        turnIndex,
      }))
    )
    .returning()
    .all();
  env.db
    .insert(voiceProfiles)
    .values(
      taught
        .filter((s) => !onlyGuest || s.turnIndex === 0)
        .map((s) => ({
          personId: s.turnIndex ? "other" : "guest",
          sampleId: s.id,
        }))
    )
    .run();
  const held = seedConversation(
    env.db,
    vectors.map((_, turnIndex) => ({
      end: turnIndex * 10 + 10,
      speakerId: labels[turnIndex] ?? "s",
      start: turnIndex * 10,
      text: "Made-up words.",
    })),
    { at: env.at + 600_000, ms: 600_000 }
  );
  env.db
    .insert(voiceSamples)
    .values(
      vectors.map((embedding, turnIndex) => ({
        conversationId: held.id,
        durationSeconds: 10,
        embedding,
        jobId: held.jobId,
        modelId: "test",
        modelRevision: "r1",
        speakerLabel: labels[turnIndex] ?? "s",
        turnIndex,
      }))
    )
    .run();
  if (several) {
    env.db
      .insert(speakerAssignments)
      .values({
        candidates: { people: ["guest", "other"], unknown: false },
        jobId: held.jobId,
        personId: "guest",
        source: "owner",
        speakerLabel: "s",
        status: "person",
      })
      .run();
  }
  const frozen = freezeNamingCase(env.db, env.data, {
    answers: answers.map((personId, turnIndex) => ({
      jobId: held.jobId,
      personId,
      speakerLabel: labels[turnIndex] ?? "s",
      turnIndex,
    })),
    at: env.at + 1_200_000,
    conversationId: held.id,
    identityEvidence: ["owner", "guest", "other"].map((personId) => ({
      at: env.at - 10_000,
      personId,
      recordingIds: [],
    })),
    partition: "held-out",
  });
  let completed = frozen;
  if (frozen.input) {
    const attemptId = `synthetic-${held.jobId}`;
    const raw = JSON.stringify({
      readings: frozen.input.scopes.map((scope) => ({
        confidence: 0,
        evidence: [],
        personId: null,
        scopeId: scope.id,
      })),
    });
    env.db
      .insert(namingAttempts)
      .values({
        call: { inputTokens: 10, outputTokens: 10, text: raw },
        conversationId: held.id,
        id: attemptId,
        inputHash: namingWorkHash(frozen.inputHash ?? "", env.data.model),
        model: env.data.model,
        policyHash: env.data.policyHash,
        promptHash: env.data.promptHash,
        snapshotRevision: 1,
        state: "abstained",
      })
      .run();
    completed = freezeNamingCase(env.db, env.data, {
      ...frozen,
      archiveHash: undefined,
      attemptId,
    });
  }
  return {
    ...env,
    replay: {
      ...env.data,
      cases: [
        ...env.data.cases.filter((c) => c.partition === "calibration"),
        completed,
      ],
    },
  };
}
test("frozen replay exercises production split scopes and owner candidate constraints", () => {
  for (const several of [false, true]) {
    const env = freezeVoiceCase(
      [HIM, HIM, PAT, PAT],
      ["s", "s", "s", "s"],
      ["guest", "guest", "other", "other"],
      several
    );
    try {
      const report = readNamingEvaluation(env.replay);
      expect(report.baseline).toMatchObject({
        correct: 4,
        precision: 1,
        predictions: 4,
      });
      expect(report.strata.group.turns).toBe(4);
    } finally {
      env.drop();
    }
  }
});
test("production nearby naming is replayed, while future profiles are removed before ranking", () => {
  const vector = (x: number, y: number, z = 0) => {
    const norm = Math.hypot(x, y, z);
    return [x / norm, y / norm, z / norm];
  };
  const vectors = [
    vector(1, 0.6),
    vector(0.5, 0.6, 0.3),
    vector(0.2, 0.5, 0.6),
  ];
  // Only the first person's profile may name the second voice nearby; remove the competing profile.
  const env = freezeVoiceCase(
    vectors,
    ["a", "b", "c"],
    ["guest", "guest", null],
    false,
    false,
    true
  );
  try {
    const report = readNamingEvaluation(env.replay);
    expect(report.baseline).toMatchObject({
      correct: 2,
      precision: 1,
      predictions: 2,
    });
    expect(report.addedContext.predictions).toBe(0);
  } finally {
    env.drop();
  }
  const future = freezeVoiceCase(
    [HIM, HIM],
    ["s", "s"],
    ["guest", "guest"],
    false,
    true
  );
  try {
    expect(readNamingEvaluation(future.replay).baseline.predictions).toBe(0);
  } finally {
    future.drop();
  }
});
test("candidate identity proof from either evaluation partition or the future is excluded", () => {
  const env = frozenFixture();
  try {
    const [first] = env.data.cases;
    assert(first);
    const excluded = env.data.cases.map((c) => ({
      ...c,
      identityEvidence: c.identityEvidence.map((e) =>
        e.personId === "guest"
          ? {
              ...e,
              recordingIds: [first.recordings[0]?.recordingId ?? "missing"],
            }
          : e
      ),
    }));
    const report = readNamingEvaluation({ ...env.data, cases: excluded });
    expect(report.receipt.passed).toBe(false);
    expect(report.receipt.predictions).toBe(0);
    const future = readNamingEvaluation({
      ...env.data,
      cases: env.data.cases.map((c) => ({
        ...c,
        identityEvidence: c.identityEvidence.map((e) =>
          e.personId === "guest" ? { ...e, at: c.at + 1 } : e
        ),
      })),
    });
    expect(future.receipt.passed).toBe(false);
    expect(future.receipt.predictions).toBe(0);
  } finally {
    env.drop();
  }
});
test("cached model, prompt, policy, snapshot and raw reply provenance cannot be relabeled", () => {
  const env = frozenFixture();
  try {
    for (const change of [
      { model: "another-model" },
      { promptHash: "old" },
      { policyHash: "old" },
      { snapshotRevision: 2 },
      { snapshotHash: "changed" },
      { raw: "{wrong}" },
    ]) {
      const cases = env.data.cases.map((c) =>
        c.call ? { ...c, call: { ...c.call, ...change } } : c
      );
      const report = readNamingEvaluation({ ...env.data, cases });
      expect(report.receipt.passed).toBe(false);
      expect(
        report.reasons.some((r) => r.includes("call provenance mismatch"))
      ).toBe(true);
    }
    const forged = readNamingEvaluation({
      ...env.data,
      cases: env.data.cases.map((c) => ({
        ...c,
        recordings: c.recordings.map((r) => ({
          ...r,
          recordingId: "forged-audio",
        })),
      })),
    });
    expect(forged.receipt.passed).toBe(false);
    expect(forged.reasons.some((r) => r.includes("recording identity"))).toBe(
      true
    );
  } finally {
    env.drop();
  }
});
test("the same semantic snapshot at a higher transport revision reuses the original frozen call", () => {
  const env = frozenFixture();
  try {
    const held = env.data.cases.find((c) => c.partition === "held-out");
    assert(held?.call);
    env.db.update(lifePeopleSnapshot).set({ revision: 2 }).run();
    const later = freezeNamingCase(env.db, env.data, {
      ...held,
      archiveHash: undefined,
      attemptId: held.call.attemptId,
    });
    expect(later.inputHash).toBe(held.inputHash);
    expect(later.input?.snapshotRevision).toBe(2);
    expect(later.call?.snapshotRevision).toBe(1);
    const report = readNamingEvaluation({
      ...env.data,
      cases: [
        ...env.data.cases.filter((c) => c.partition === "calibration"),
        later,
      ],
    });
    expect(report.overall).toMatchObject({ correct: 2, predictions: 2 });
  } finally {
    env.drop();
  }
});
test("a genuine naming queue cached call freezes and replays with the production work key", async () => {
  const env = frozenFixture();
  try {
    env.db.delete(namingAttempts).run();
    const calibrated = env.data.cases.find((c) => c.partition === "calibration")
      ?.answers[0];
    assert(calibrated);
    env.db
      .insert(speakerAssignments)
      .values({
        jobId: calibrated.jobId,
        source: "owner",
        speakerLabel: calibrated.speakerLabel,
        status: "unknown",
      })
      .run();
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
    const provider = fakeModel((call) => {
      const input = JSON.parse(call.user) as NamingInput;
      return {
        readings: input.scopes.map((scope) => ({
          confidence: 0.99,
          evidence: [{ quote: "I am Guest.", turn: 0 }],
          personId: "guest",
          scopeId: scope.id,
        })),
      };
    });
    provider.name = "codex";
    provider.model = env.data.model;
    const queue = namingPass(
      env.db,
      {
        able: () => true,
        idle: () => true,
        llm: () => Promise.reject(new Error("unexpected real transport")),
      },
      provider
    );
    let outcome = await queue.run({ engine: "codex", mode: "evaluation" });
    while (outcome === "advancing") {
      // biome-ignore lint/performance/noAwaitInLoops: advance bounded, synchronous fixture windows
      outcome = await queue.run({ engine: "codex", mode: "evaluation" });
    }
    expect(outcome).not.toBe("advancing");
    expect(outcome).not.toBe("idle");
    expect(outcome).not.toBe("paused");
    const attempt = env.db
      .select()
      .from(namingAttempts)
      .all()
      .find((a) => a.conversationId === env.held.id);
    const held = env.data.cases.find((c) => c.partition === "held-out");
    assert(attempt && held);
    expect(provider.calls).toHaveLength(1);
    expect(attempt.inputHash).toBe(
      namingWorkHash(held.inputHash ?? "", env.data.model)
    );
    const frozen = freezeNamingCase(env.db, env.data, {
      ...held,
      archiveHash: undefined,
      attemptId: attempt.id,
    });
    const replayed = readNamingEvaluation({
      ...env.data,
      cases: [
        ...env.data.cases.filter((c) => c.partition === "calibration"),
        frozen,
      ],
    });
    expect(replayed.overall).toMatchObject({ correct: 2, predictions: 2 });
    const missing = readNamingEvaluation({
      ...env.data,
      cases: [
        ...env.data.cases.filter((c) => c.partition === "calibration"),
        { ...frozen, call: null },
      ],
    });
    expect(
      missing.reasons.some((r) => r.includes("missing call provenance"))
    ).toBe(true);
  } finally {
    env.drop();
  }
});
test("frozen cases share one immutable snapshot entry and reuse its reference", () => {
  const env = frozenFixture();
  try {
    expect(Object.keys(env.data.snapshots)).toHaveLength(1);
    expect(new Set(env.data.cases.map((c) => c.archiveHash)).size).toBe(1);
    expect(JSON.stringify(env.data.cases)).not.toContain('"archive":');
    const held = env.data.cases.find((c) => c.partition === "held-out");
    assert(held?.call);
    const again = freezeNamingCase(env.db, env.data, {
      ...held,
      attemptId: held.call.attemptId,
    });
    expect(again.archiveHash).toBe(held.archiveHash);
    expect(Object.keys(env.data.snapshots)).toHaveLength(1);
    expect(again.call).toEqual(held.call);
  } finally {
    env.drop();
  }
});
test("a passing mixed context and voice-only evaluation produces an installable receipt", () => {
  const original = NAMING.calibration;
  Object.assign(NAMING, { calibration });
  const source = testDb();
  const data: FrozenNamingEvaluation[] = [];
  const voice = freezeVoiceCase([HIM, HIM], ["s", "s"], ["guest", "guest"]);
  try {
    for (let i = 0; i < 200; i += 1) {
      source.reset();
      data.push(frozenFixture(false, 1, false, source).data);
    }
    const [first] = data;
    assert(first);
    const report = readNamingEvaluation({
      ...first,
      cases: [...data.flatMap((f) => f.cases), ...voice.replay.cases],
      snapshots: Object.assign(
        {},
        ...data.map((f) => f.snapshots),
        voice.replay.snapshots
      ),
    });
    expect(report).toMatchObject({
      baseline: { predictions: 2 },
      reasons: [],
      receipt: { callPredictions: 200, passed: true },
    });
    expect(isNamingGate(report.receipt, first.model)).toBe(true);
  } finally {
    voice.drop();
    source.drop();
    Object.assign(NAMING, { calibration: original });
  }
});
