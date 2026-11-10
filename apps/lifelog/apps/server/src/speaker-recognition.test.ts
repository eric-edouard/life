import { afterAll, beforeEach, expect, test } from "bun:test";
import { people, speakerAssignments, voiceProfiles } from "@lifelog/db/schema";
import { buildNamingInput } from "./inferred-speakers";
import { assign, speakerOf } from "./people";
import {
  recognize,
  recognizeJob,
  reconcileNaming,
} from "./speaker-recognition";
import { seedTranscript, testDb } from "./testing";

const env = testDb();
afterAll(env.drop);
beforeEach(env.reset);
const calibration = {
  confidence: 0.99,
  contradictionMargin: 0.2,
  contradictionScore: 0.8,
};
function seed() {
  const jobId = seedTranscript(env.db, [
    { end: 5, speakerId: "s", start: 0, text: "My name is Dara." },
  ]);
  env.db.insert(people).values({ id: "person", name: "Dara" }).run();
  const input = buildNamingInput({
    conversationId: "conversation",
    people: [
      {
        aliases: [],
        canonicalRef: "person:dara",
        name: "Dara",
        personId: "person",
      },
    ],
    snapshotRevision: 1,
    targets: [
      {
        id: "scope",
        jobId,
        profiles: { people: [], strangers: [] },
        speakerLabel: "s",
        turnIndices: [0],
        vector: null,
      },
    ],
    turns: [
      { jobId, speakerLabel: "s", text: "My name is Dara.", turnIndex: 0 },
    ],
  });
  const pass = {
    attemptId: "attempt",
    calibration,
    input,
    readings: [
      {
        confidence: 1,
        evidence: [{ quote: "My name is Dara.", turn: 0 }],
        personId: "person",
        scopeId: "scope",
      },
    ],
    resolvePerson: (id: string) => id,
  };
  return { jobId, pass };
}
test("context names exact turns without embeddings, survives sweeps and never supplies evidence", () => {
  const { jobId, pass } = seed();
  env.db.transaction((tx) =>
    recognizeJob(tx, jobId, new Map(), undefined, pass)
  );
  recognize(env.db, jobId);
  const named = speakerOf(
    env.db.select().from(speakerAssignments).all(),
    "s",
    0
  );
  expect(named).toMatchObject({
    inference: { attemptId: "attempt", confidence: 1 },
    personId: "person",
    source: "inferred",
  });
  expect(env.db.select().from(voiceProfiles).all()).toEqual([]);
});
test("owner unknown and media answers block a context replay", () => {
  for (const kind of ["unknown", "media"] as const) {
    env.reset();
    const { jobId, pass } = seed();
    assign(env.db, {
      jobId,
      speakerLabel: "s",
      target: { kind },
      turnIndex: null,
    });
    env.db.transaction((tx) =>
      recognizeJob(tx, jobId, new Map(), undefined, pass)
    );
    expect(
      speakerOf(env.db.select().from(speakerAssignments).all(), "s", 0)
    ).toMatchObject({ personId: null, source: "owner" });
  }
});

test("changed input or candidate revision refuses the transaction", () => {
  const { jobId, pass } = seed();
  expect(
    reconcileNaming(
      env.db,
      pass,
      () => ({ ...pass.input, inputHash: "changed" }),
      (_, id) => id
    )
  ).toBe(false);
  expect(
    reconcileNaming(
      env.db,
      pass,
      () => ({ ...pass.input, snapshotHash: "changed", snapshotRevision: 2 }),
      (_, id) => id
    )
  ).toBe(false);
  expect(env.db.select().from(speakerAssignments).all()).toEqual([]);
  expect(
    reconcileNaming(
      env.db,
      pass,
      () => pass.input,
      (_, id) => id
    )
  ).toBe(true);
  expect(recognize(env.db, jobId)).toBe(false);
});

test("an ordering-only snapshot revision reuses identical semantic input", () => {
  const { jobId, pass } = seed();
  expect(
    reconcileNaming(
      env.db,
      pass,
      () => ({ ...pass.input, snapshotRevision: 2 }),
      (_, id) => id
    )
  ).toBe(true);
  expect(
    speakerOf(env.db.select().from(speakerAssignments).all(), "s", 0)?.inference
      ?.snapshotRevision
  ).toBe(2);
  expect(recognize(env.db, jobId)).toBe(false);
});
