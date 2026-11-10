import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { NAMING } from "./config";
import {
  buildNamingInput,
  parseNamingReadings,
  readInferredSpeakers,
} from "./inferred-speakers";
import type { Provider } from "./providers";
import {
  decideInferredName,
  type InferredReading,
  NO_PROFILES,
} from "./speakers";

const people = [
  { aliases: [], canonicalRef: "owner", name: "Owner", personId: "owner" },
  {
    aliases: ["Lea"],
    canonicalRef: "person_1",
    name: "Leonie",
    personId: "person_1",
  },
];
const turns = [
  {
    jobId: "job",
    personId: "person_1",
    source: "inferred" as const,
    speakerLabel: "s0",
    text: "Hello, I am Leonie.",
    turnIndex: 0,
  },
  {
    jobId: "job",
    personId: "owner",
    source: "owner" as const,
    speakerLabel: "s1",
    text: "Hello. The two of us are here.",
    turnIndex: 1,
  },
];
const targets = [
  {
    clean: true,
    id: "scope",
    jobId: "job",
    profiles: NO_PROFILES,
    speakerLabel: "s0",
    turnIndices: [0],
    vector: null,
  },
];
const [target] = targets;
const [firstTurn] = turns;
const [ownerPerson] = people;
assert(target);
assert(firstTurn);
assert(ownerPerson);
const input = () =>
  buildNamingInput({
    conversationId: "conversation",
    people,
    snapshotRevision: 1,
    targets,
    turns,
  });
const reading: InferredReading = {
  basis: "context",
  confidence: 0.99,
  evidence: [{ quote: "I am Leonie.", turn: 0 }],
  personId: "person_1",
};
const raw = (changes: Record<string, unknown> = {}) =>
  JSON.stringify({ readings: [{ ...reading, scopeId: "scope", ...changes }] });
const calibration = {
  confidence: 0.98,
  contradictionMargin: 0.15,
  contradictionScore: 0.65,
};
const unnamed = { isStranger: false, personId: null, vector: null };

test("naming input strips target names, inferred presence and embeddings; hashes snapshot and checked scope", () => {
  const built = input();
  expect(built.turns[0]?.personId).toBeNull();
  expect(built.turns[1]?.personId).toBe("owner");
  expect(JSON.stringify(built)).not.toContain('"vector"');
  expect(JSON.stringify(built)).not.toContain('"profiles"');
  expect(input().inputHash).toBe(built.inputHash);
  expect(
    buildNamingInput({
      conversationId: "conversation",
      people,
      snapshotRevision: 2,
      targets,
      turns,
    }).inputHash
  ).toBe(built.inputHash);
  expect(() =>
    buildNamingInput({
      conversationId: "conversation",
      people,
      snapshotRevision: 1,
      targets: [{ ...target, turnIndices: [1] }],
      turns,
    })
  ).toThrow("exact transcript turns");
});

test("nearby-derived recognized names cannot become recursive trusted presence", () => {
  const recognized = turns.map((t) => ({
    ...t,
    source: "recognized" as const,
  }));
  const build = (direct: boolean) =>
    buildNamingInput({
      conversationId: "conversation",
      people,
      snapshotRevision: 1,
      targets,
      turns: recognized.map((t) => ({ ...t, isDirectMatch: direct })),
    });
  expect(build(false).turns[1]?.personId).toBeNull();
  expect(build(true).turns[1]?.personId).toBe("owner");
  expect(build(true).turns[0]?.personId).toBeNull();
});

test("model readings require finite confidence, exact quotes, candidate and target membership, no extra keys", () => {
  expect(parseNamingReadings(raw(), input())).toEqual([
    { ...reading, scopeId: "scope" },
  ]);
  for (const changes of [
    { personId: "invented" },
    { confidence: 2 },
    { confidence: null },
    { scopeId: "elsewhere" },
    { evidence: [] },
    { instruction: "do something" },
    { evidence: [{ quote: "I am Leona.", turn: 0 }] },
    { evidence: [{ quote: "I am Leonie.", turn: 8 }] },
  ]) {
    expect(() => parseNamingReadings(raw(changes), input())).toThrow();
  }
  expect(() =>
    parseNamingReadings(JSON.stringify({ readings: [] }), input())
  ).toThrow();
  const restricted = input();
  const [scope] = restricted.scopes;
  assert(scope);
  scope.candidates = { people: ["owner"], unknown: true };
  expect(() => parseNamingReadings(raw(), restricted)).toThrow("candidates");
});

test("oversized contexts fail before any model call and canonical candidates must be unique", () => {
  expect(() =>
    buildNamingInput({
      conversationId: "conversation",
      people,
      snapshotRevision: 1,
      targets,
      turns: [{ ...firstTurn, text: "x".repeat(NAMING.contextMaxChars + 1) }],
    })
  ).toThrow("bounds");
  expect(() =>
    buildNamingInput({
      conversationId: "conversation",
      people: [ownerPerson, ownerPerson],
      snapshotRevision: 1,
      targets,
      turns,
    })
  ).toThrow("canonical");
});

test("two-person rule needs independently exhaustive participants and clean remaining turns", () => {
  expect(() =>
    parseNamingReadings(raw({ basis: "two-person" }), input())
  ).toThrow("premise");
  const built = buildNamingInput({
    conversationId: "conversation",
    participants: {
      evidence: [{ quote: "The two of us are here.", turn: 1 }],
      personIds: ["owner", "person_1"],
      source: "owner",
    },
    people,
    snapshotRevision: 1,
    targets,
    turns,
  });
  const [two] = parseNamingReadings(raw({ basis: "two-person" }), built);
  assert(two);
  const context = {
    calibration,
    hasOnlyCleanRemainingTurns: true,
    ownerId: "owner",
    trustedParticipants: built.participants?.personIds,
  };
  expect(decideInferredName(unnamed, NO_PROFILES, two, context)).toBe(
    "person_1"
  );
  expect(
    decideInferredName(unnamed, NO_PROFILES, two, {
      ...context,
      trustedParticipants: ["owner", "person_1", "person_2"],
    })
  ).toBeNull();
  expect(
    decideInferredName(unnamed, NO_PROFILES, two, {
      ...context,
      hasOnlyCleanRemainingTurns: false,
    })
  ).toBeNull();
  expect(
    decideInferredName(
      unnamed,
      NO_PROFILES,
      { ...two, personId: "owner" },
      context
    )
  ).toBeNull();
});

test("voice decisions win; calibrated contradictions block context but absent embeddings permit it", () => {
  expect(
    decideInferredName(unnamed, NO_PROFILES, reading, { calibration })
  ).toBe("person_1");
  expect(
    decideInferredName(unnamed, NO_PROFILES, reading, { calibration: null })
  ).toBeNull();
  expect(
    decideInferredName(
      { ...unnamed, personId: "owner" },
      NO_PROFILES,
      reading,
      { calibration }
    )
  ).toBe("owner");
  expect(
    decideInferredName({ ...unnamed, isStranger: true }, NO_PROFILES, reading, {
      calibration,
    })
  ).toBeNull();
  expect(
    decideInferredName(
      unnamed,
      NO_PROFILES,
      { ...reading, confidence: 0.9 },
      { calibration }
    )
  ).toBeNull();
  expect(
    decideInferredName(unnamed, NO_PROFILES, reading, {
      calibration,
      candidates: { people: ["owner"], unknown: true },
    })
  ).toBeNull();
  const profiles = {
    people: [{ exemplars: [[1, 0]], isOwner: true, personId: "owner" }],
    strangers: [],
  };
  expect(
    decideInferredName({ ...unnamed, vector: [1, 0] }, profiles, reading, {
      calibration,
    })
  ).toBeNull();
});

test("subscription call freezes Codex and validates before returning; no fallback", async () => {
  const calls: string[] = [];
  const provider: Provider = {
    call: (call) => {
      calls.push(call.user);
      return Promise.resolve({
        inputTokens: 10,
        outputTokens: 20,
        text: raw(),
      });
    },
    model: "synthetic",
    name: "codex",
  };
  expect(
    (await readInferredSpeakers(provider, input())).readings[0]?.personId
  ).toBe("person_1");
  expect(calls).toHaveLength(1);
  await expect(
    readInferredSpeakers({ ...provider, name: "claude-code" }, input())
  ).rejects.toThrow("Codex");
  expect(calls).toHaveLength(1);
});

test("semantic input hashing ignores candidate order and snapshot revision but binds snapshot content", () => {
  const built = input();
  expect(
    buildNamingInput({
      conversationId: "conversation",
      people: [...people].reverse(),
      snapshotRevision: 999,
      targets,
      turns,
    }).inputHash
  ).toBe(built.inputHash);
  expect(
    buildNamingInput({
      conversationId: "conversation",
      people,
      snapshotHash: "changed-snapshot-content",
      snapshotRevision: 1,
      targets,
      turns,
    }).inputHash
  ).not.toBe(built.inputHash);
});
