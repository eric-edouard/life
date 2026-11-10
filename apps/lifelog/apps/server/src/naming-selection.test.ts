import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import {
  conversations,
  lifePeopleSnapshot,
  namingAttempts,
  people,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { logChange } from "./change-log";
import { NAMING } from "./config";
import { buildNamingInput, namingWorkHash } from "./inferred-speakers";
import { readCurrentNamingInput, readNamingInputs } from "./naming-pass";
import { namingSelection } from "./naming-selection";
import { seedConversation, testDb } from "./testing";

const env = testDb();
afterAll(env.drop);
beforeEach(env.reset);
const older = "00000000-0000-4000-8000-000000000001";
const newer = "00000000-0000-4000-8000-000000000002";
const seed = (id: typeof older | typeof newer, at: string) => {
  const made = seedConversation(
    env.db,
    [{ end: 10, speakerId: "s", start: 0, text: "A synthetic greeting." }],
    { at: Date.parse(at), id }
  );
  env.db
    .update(conversations)
    .set({ createdAt: new Date(at) })
    .where(eq(conversations.id, id))
    .run();
  return made;
};

test("selection loads only one conversation per tick and skips unchanged exhausted context", () => {
  seed(older, "2026-10-01T02:00:00Z");
  seed(newer, "2026-10-02T02:00:00Z");
  const loaded: string[] = [];
  const read = namingSelection(env.db, (_db, id) => {
    loaded.push(id);
    return [];
  });
  read("model", new Date(0), "evaluation", false);
  expect(loaded).toEqual([newer]);
  read("model", new Date(0), "evaluation", false);
  expect(loaded).toEqual([newer, older]);
  read("model", new Date(0), "evaluation", false);
  expect(loaded).toHaveLength(2);
  logChange(env.db, "conversation", older);
  read("model", new Date(0), "evaluation", false);
  expect(loaded).toEqual([newer, older, older]);
});

test("new candidate and profile changes invalidate other conversations without eagerly loading them", () => {
  const { jobId } = seed(older, "2026-10-01T02:00:00Z");
  seed(newer, "2026-10-02T02:00:00Z");
  const loaded: string[] = [];
  const read = namingSelection(env.db, (_db, id) => {
    loaded.push(id);
    return [];
  });
  const tick = () => read("model", new Date(0), "evaluation", false);
  tick();
  tick();
  const p = env.db.insert(people).values({ name: "Aster" }).returning().get();
  logChange(env.db, "person", p.id);
  tick();
  expect(loaded).toEqual([newer, older, newer]);
  tick();
  const sample = env.db
    .insert(voiceSamples)
    .values({
      conversationId: older,
      durationSeconds: 10,
      embedding: [1, 0],
      jobId,
      modelId: "synthetic",
      modelRevision: "1",
      speakerLabel: "s",
      turnIndex: 0,
    })
    .returning()
    .get();
  env.db
    .insert(voiceProfiles)
    .values({ personId: p.id, sampleId: sample.id })
    .run();
  tick();
  expect(loaded).toHaveLength(5);
  expect(loaded.at(-1)).toBe(newer);
});

test("each tick advances one bounded window without rebuilding exhausted earlier windows", () => {
  seed(newer, "2026-10-02T02:00:00Z");
  let built = 0;
  function* windows() {
    for (const id of ["first", "second", "third"]) {
      built += 1;
      yield buildNamingInput({
        conversationId: newer,
        people: [],
        snapshotRevision: 1,
        targets: [
          {
            id,
            jobId: "job",
            profiles: { people: [], strangers: [] },
            speakerLabel: "s",
            turnIndices: [0],
            vector: null,
          },
        ],
        turns: [
          {
            jobId: "job",
            speakerLabel: "s",
            text: "A synthetic greeting.",
            turnIndex: 0,
          },
        ],
      });
    }
  }
  const inputs = [...windows()];
  for (const input of inputs.slice(0, 2)) {
    env.db
      .insert(namingAttempts)
      .values({
        conversationId: newer,
        inputHash: namingWorkHash(input.inputHash, "model"),
        model: "model",
        policyHash: "policy",
        promptHash: "prompt",
        snapshotRevision: 1,
        state: "named",
      })
      .run();
  }
  built = 0;
  const read = namingSelection(env.db, windows);
  expect(read("model", new Date(0), "evaluation", false)).toBe("advancing");
  expect(built).toBe(1);
  expect(read("model", new Date(0), "evaluation", false)).toBe("advancing");
  expect(built).toBe(2);
  const selected = read("model", new Date(0), "evaluation", false);
  expect(
    selected && selected !== "advancing" && selected.input.scopes[0]?.id
  ).toBe("third");
  expect(built).toBe(3);
  read("model", new Date(0), "evaluation", false);
  expect(built).toBe(3);
});

test("empty bounded transcript windows advance separately instead of scanning the conversation", () => {
  seed(newer, "2026-10-02T02:00:00Z");
  let built = 0;
  function* windows() {
    for (let i = 0; i < 3; i += 1) {
      built += 1;
      yield null;
    }
  }
  const read = namingSelection(env.db, windows);
  for (let i = 1; i <= 3; i += 1) {
    expect(read("model", new Date(0), "evaluation", false)).toBe("advancing");
    expect(built).toBe(i);
  }
  expect(read("model", new Date(0), "evaluation", false)).toBeNull();
  expect(built).toBe(3);
});

test("writer revalidation reads only the chosen late transcript chunk", () => {
  env.db
    .insert(lifePeopleSnapshot)
    .values({
      folds: {},
      hash: "snapshot",
      people: [
        { aliases: [], name: "Guest", personId: null, ref: "person:guest" },
      ],
      revision: 1,
    })
    .run();
  const made = seedConversation(
    env.db,
    Array.from({ length: NAMING.contextMaxTurns * 3 + 1 }, (_, index) => ({
      end: index + 1,
      speakerId: "s",
      start: index,
      text: "Synthetic greeting.",
    })),
    { ms: (NAMING.contextMaxTurns * 3 + 2) * 1000 }
  );
  const inputs = [...readNamingInputs(env.db, made.id)];
  const [first] = inputs;
  const last = inputs.at(-1);
  assert(first);
  assert(last);
  const reads = spyOn(env.db, "select");
  try {
    expect(readCurrentNamingInput(env.db, first)?.inputHash).toBe(
      first.inputHash
    );
    const firstReads = reads.mock.calls.length;
    reads.mockClear();
    expect(readCurrentNamingInput(env.db, last)?.inputHash).toBe(
      last.inputHash
    );
    expect(reads.mock.calls).toHaveLength(firstReads);
  } finally {
    reads.mockRestore();
  }
});
