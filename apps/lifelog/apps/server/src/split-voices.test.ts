import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  people,
  speakerAssignments,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { turnRef } from "./change-log";
import { buildNamingInput } from "./inferred-speakers";
import { assign } from "./people";
import { ofItsSpeaker, readOwnTurns } from "./recognized-rows";
import {
  readProfiles,
  recognize,
  recognizeJob,
  regroup,
} from "./speaker-recognition";
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

const first = [1, 0, 0];
const second = [0, 1, 0];
const ownerVoice = [0, 0, 1];

function seed(
  vectors: number[][],
  seconds = vectors.map(() => 10),
  models = vectors.map(() => "test"),
  labels = vectors.map(() => "mixed")
) {
  let start = 0;
  const turns = vectors.map((_, i) => {
    const end = start + (seconds[i] ?? 10);
    const turn = {
      end,
      speakerId: labels[i] ?? "mixed",
      start,
      text: "Made-up speech.",
    };
    start = end;
    return turn;
  });
  const held = seedConversation(env.db, turns);
  const samples = env.db
    .insert(voiceSamples)
    .values(
      vectors.map((embedding, turnIndex) => ({
        conversationId: held.id,
        durationSeconds: seconds[turnIndex] ?? 10,
        embedding,
        jobId: held.jobId,
        modelId: models[turnIndex] ?? "test",
        modelRevision: "r1",
        speakerLabel: labels[turnIndex] ?? "mixed",
        turnIndex,
      }))
    )
    .returning()
    .all();
  return { ...held, samples };
}

const rowsOf = (jobId: string) =>
  env.db
    .select()
    .from(speakerAssignments)
    .where(eq(speakerAssignments.jobId, jobId))
    .all();
const turnRowsOf = (jobId: string) =>
  rowsOf(jobId)
    .filter((r) => r.turnIndex !== null)
    .sort((a, b) => (a.turnIndex ?? 0) - (b.turnIndex ?? 0));

function teach(embedding: number[], isOwner = false) {
  const personId = randomUUID();
  env.db
    .insert(people)
    .values({ id: personId, isOwner, name: isOwner ? "Owner" : "Guest" })
    .run();
  const held = seed([embedding]);
  env.db
    .insert(voiceProfiles)
    .values({ personId, sampleId: held.samples[0]?.id ?? "" })
    .run();
  return personId;
}

test("two sampled voices split into recognized unnamed turn rows, without people or evidence", () => {
  const held = seed([first, first, second, second], [12, 12, 10, 10]);
  expect(recognize(env.db, held.jobId)).toBe(true);
  const rows = rowsOf(held.jobId);
  expect(rows.filter((r) => r.turnIndex === null)).toHaveLength(1);
  const split = turnRowsOf(held.jobId);
  expect(split.map((r) => r.turnIndex)).toEqual([2, 3]);
  expect(
    split.every(
      (r) =>
        r.source === "recognized" &&
        r.status === "candidate" &&
        r.personId === null
    )
  ).toBe(true);
  expect(split[0]?.candidateId).toBeString();
  expect(split[0]?.candidateId).toBe(split[1]?.candidateId);
  expect(env.db.select().from(people).all()).toEqual([]);
  expect(env.db.select().from(voiceProfiles).all()).toEqual([]);
});

test("a successful split recognized twice is unchanged with identical candidate ids", () => {
  const held = seed([first, first, second, second], [12, 12, 10, 10]);
  expect(recognize(env.db, held.jobId)).toBe(true);
  const before = rowsOf(held.jobId);
  expect(recognize(env.db, held.jobId)).toBe(false);
  expect(rowsOf(held.jobId)).toEqual(before);
});

test("one long dissimilar turn does not establish a second voice", () => {
  const held = seed([first, first, second], [12, 12, 30]);
  recognize(env.db, held.jobId);
  expect(turnRowsOf(held.jobId)).toEqual([]);
});

test("repeated speech in two conditions needs stronger separation than the grouping threshold", () => {
  const held = seed([
    first,
    first,
    [0.45, Math.sqrt(1 - 0.45 ** 2), 0],
    [0.45, Math.sqrt(1 - 0.45 ** 2), 0],
  ]);
  recognize(env.db, held.jobId);
  expect(turnRowsOf(held.jobId)).toEqual([]);
});

test("one voice in two rooms above the likeness threshold stays together", () => {
  const held = seed([first, first, [0.8, 0.6, 0], [0.8, 0.6, 0]]);
  recognize(env.db, held.jobId);
  expect(turnRowsOf(held.jobId)).toEqual([]);
});

test("a dissimilar group with too little speech does not split", () => {
  const held = seed([first, first, second], [12, 12, 7]);
  recognize(env.db, held.jobId);
  expect(turnRowsOf(held.jobId)).toEqual([]);
});

test("weak owner turns keep the aggregate match after the strong owner turns leave", () => {
  const ownerId = teach(first, true);
  const held = seed([
    first,
    first,
    [0.57, Math.sqrt(1 - 0.57 ** 2), 0],
    [0.59, 0, Math.sqrt(1 - 0.59 ** 2)],
  ]);
  recognize(env.db, held.jobId);
  expect(rowsOf(held.jobId).find((r) => r.turnIndex === null)?.personId).toBe(
    ownerId
  );
  expect(turnRowsOf(held.jobId)).toEqual([]);
});

test("owner turns leave first, then the remaining two voices split", () => {
  const ownerId = teach(ownerVoice, true);
  const held = seed(
    [first, first, second, second, ownerVoice],
    [12, 12, 10, 10, 20]
  );
  recognize(env.db, held.jobId);
  const split = turnRowsOf(held.jobId);
  expect(split.map((r) => r.turnIndex)).toEqual([2, 3, 4]);
  expect(split.find((r) => r.turnIndex === 4)).toMatchObject({
    personId: ownerId,
    source: "recognized",
    status: "person",
  });
  expect(
    split
      .filter((r) => r.turnIndex !== 4)
      .every((r) => r.status === "candidate")
  ).toBe(true);
});

test("an owner correction wins over the automatic split and survives recognition", () => {
  const held = seed([first, first, second, second], [12, 12, 10, 10]);
  recognize(env.db, held.jobId);
  const personId = randomUUID();
  assign(env.db, {
    jobId: held.jobId,
    speakerLabel: "mixed",
    target: { id: personId, kind: "new", name: "Guest" },
    turnIndex: 2,
  });
  recognize(env.db, held.jobId);
  expect(turnRowsOf(held.jobId).filter((r) => r.turnIndex === 2)).toHaveLength(
    1
  );
  expect(turnRowsOf(held.jobId).find((r) => r.turnIndex === 2)).toMatchObject({
    personId,
    source: "owner",
    status: "person",
  });
});

test("recognized split rows keep their group when recognition runs again after a sample changes", () => {
  const held = seed([first, first, second, second], [12, 12, 10, 10]);
  recognize(env.db, held.jobId);
  const before = turnRowsOf(held.jobId);
  env.db
    .update(voiceSamples)
    .set({ embedding: first })
    .where(eq(voiceSamples.id, held.samples[2]?.id ?? ""))
    .run();
  teach(first);
  expect(recognize(env.db, held.jobId)).toBe(true);
  const withoutIdentity = (rows: ReturnType<typeof turnRowsOf>) =>
    rows.map(({ id: _, updatedAt: __, ...row }) => row);
  expect(withoutIdentity(turnRowsOf(held.jobId))).toEqual(
    withoutIdentity(before)
  );
});

test("different embedding models never become groups of the same split", () => {
  const held = seed(
    [first, first, second, second],
    [12, 12, 10, 10],
    ["one", "one", "two", "two"]
  );
  recognize(env.db, held.jobId);
  expect(turnRowsOf(held.jobId)).toEqual([]);
});

test("a split group matches a known voice without adding evidence", () => {
  const personId = teach(second);
  const evidence = env.db.select().from(voiceProfiles).all();
  const held = seed([first, first, second, second], [12, 12, 10, 10]);
  recognize(env.db, held.jobId);
  expect(
    turnRowsOf(held.jobId).map((r) => [r.turnIndex, r.personId, r.source])
  ).toEqual([
    [2, personId, "recognized"],
    [3, personId, "recognized"],
  ]);
  expect(env.db.select().from(voiceProfiles).all()).toEqual(evidence);
});

test("regroup reads split turn groups and may merge them with another label", async () => {
  const held = seed(
    [first, first, second, second, second],
    [12, 12, 10, 10, 12],
    undefined,
    ["mixed", "mixed", "mixed", "mixed", "other"]
  );
  recognize(env.db, held.jobId);
  const splitId = turnRowsOf(held.jobId)[0]?.candidateId;
  expect(splitId).toBeString();
  expect(await regroup(env.db)).toBeGreaterThan(0);
  const rows = rowsOf(held.jobId);
  const other = rows.find((r) => r.speakerLabel === "other");
  expect(other?.candidateId).toBeString();
  expect(
    turnRowsOf(held.jobId).every((r) => r.candidateId === other?.candidateId)
  ).toBe(true);
  const again = turnRowsOf(held.jobId);
  recognize(env.db, held.jobId);
  expect(turnRowsOf(held.jobId)).toEqual(again);
});

test("an unsampled turn remains with the label after the clean turns split", () => {
  const held = seed(
    [first, first, second, second, second],
    [12, 12, 10, 10, 1]
  );
  env.db
    .delete(voiceSamples)
    .where(eq(voiceSamples.id, held.samples[4]?.id ?? ""))
    .run();
  recognize(env.db, held.jobId);
  expect(turnRowsOf(held.jobId).map((r) => r.turnIndex)).toEqual([2, 3]);
  expect(rowsOf(held.jobId).find((r) => r.turnIndex === null)?.source).toBe(
    "recognized"
  );
});

test("owner turns leave even when the aggregate matches the owner, without duplicate rows", () => {
  const ownerId = teach([1, 0, 0], true);
  const guestId = teach([0, 1, 0]);
  const held = seed([
    ...Array.from({ length: 6 }, () => [0.8, 0, -0.6]),
    [0, 1, 0],
    [0, 1, 0],
    [0.7, 0.65, Math.sqrt(1 - 0.7 ** 2 - 0.65 ** 2)],
    [0, 0, 1],
    [0, 0, 1],
  ]);
  expect(() => recognize(env.db, held.jobId)).not.toThrow();
  const rows = rowsOf(held.jobId);
  expect(rows.filter((r) => r.turnIndex === 8)).toHaveLength(1);
  expect(rows.find((r) => r.turnIndex === 8)?.personId).toBe(ownerId);
  expect(rows.find((r) => r.turnIndex === null)?.personId).toBe(guestId);
});

test("own-turn SQL stays correlated in SELECT and WHERE, matching the JS rule", () => {
  const split = seed([first, second]);
  const whole = seed([first]);
  env.db
    .insert(speakerAssignments)
    .values([
      {
        jobId: split.jobId,
        source: "recognized",
        speakerLabel: "mixed",
        status: "unknown",
        turnIndex: 1,
      },
      {
        jobId: whole.jobId,
        source: "recognized",
        speakerLabel: "mixed",
        status: "unknown",
        turnIndex: null,
      },
    ])
    .run();
  const ownTurns = readOwnTurns(env.db);
  const clean = ofItsSpeaker(voiceSamples.jobId, voiceSamples.turnIndex);
  const selected = env.db
    .select({ clean, sample: voiceSamples })
    .from(voiceSamples)
    .all();
  expect(selected).toHaveLength(3);
  for (const row of selected) {
    expect(Boolean(row.clean)).toBe(
      !ownTurns.has(turnRef(row.sample.jobId, row.sample.turnIndex))
    );
  }
  const filtered = env.db.select().from(voiceSamples).where(clean).all();
  expect(
    filtered.map((row) => turnRef(row.jobId, row.turnIndex)).sort()
  ).toEqual([turnRef(split.jobId, 0), turnRef(whole.jobId, 0)].sort());
});

const contextPerson = () => {
  const id = randomUUID();
  env.db.insert(people).values({ id, name: "Aster" }).run();
  return id;
};
function keepInference(jobId: string, indices: number[], personId: string) {
  env.db
    .insert(speakerAssignments)
    .values(
      indices.map((turnIndex) => ({
        jobId,
        personId,
        source: "inferred" as const,
        speakerLabel: "mixed",
        status: "person" as const,
        turnIndex,
      }))
    )
    .run();
}
test("a newly recognized split preserves inference on the unrelated main turns", () => {
  const other = teach(second);
  const held = seed([first, first, second, second], [12, 12, 10, 10]);
  const inferred = contextPerson();
  keepInference(held.jobId, [0, 1], inferred);
  recognize(env.db, held.jobId);
  expect(
    turnRowsOf(held.jobId).map((r) => [r.turnIndex, r.personId, r.source])
  ).toEqual([
    [0, inferred, "inferred"],
    [1, inferred, "inferred"],
    [2, other, "recognized"],
    [3, other, "recognized"],
  ]);
});
test("a newly recognized main voice preserves inference on its explicit unnamed split", () => {
  const main = teach(first);
  const held = seed([first, first, second, second], [12, 12, 10, 10]);
  const inferred = contextPerson();
  keepInference(held.jobId, [2, 3], inferred);
  recognize(env.db, held.jobId);
  expect(rowsOf(held.jobId).find((r) => r.turnIndex === null)?.personId).toBe(
    main
  );
  expect(
    turnRowsOf(held.jobId).map((r) => [r.turnIndex, r.personId, r.source])
  ).toEqual([
    [2, inferred, "inferred"],
    [3, inferred, "inferred"],
  ]);
});
test("context can name an exact unnamed split behind a recognized main label", () => {
  const main = teach(first);
  const held = seed([first, first, second, second], [12, 12, 10, 10]);
  const inferred = contextPerson();
  const input = buildNamingInput({
    conversationId: held.id,
    people: [
      {
        aliases: [],
        canonicalRef: "person:aster",
        name: "Aster",
        personId: inferred,
      },
    ],
    snapshotRevision: 1,
    targets: [
      {
        clean: true,
        id: "split",
        jobId: held.jobId,
        profiles: { people: [], strangers: [] },
        speakerLabel: "mixed",
        turnIndices: [2, 3],
        vector: second,
      },
    ],
    turns: [0, 1, 2, 3].map((turnIndex) => ({
      jobId: held.jobId,
      speakerLabel: "mixed",
      text: "Made-up speech.",
      turnIndex,
    })),
  });
  env.db.transaction((tx) =>
    recognizeJob(tx, held.jobId, readProfiles(tx), undefined, {
      attemptId: "synthetic",
      calibration: {
        confidence: 0.99,
        contradictionMargin: 0.2,
        contradictionScore: 0.8,
      },
      input,
      readings: [
        {
          basis: "context",
          confidence: 1,
          evidence: [{ quote: "Made-up speech.", turn: 2 }],
          personId: inferred,
          scopeId: "split",
        },
      ],
      resolvePerson: (id) => id,
    })
  );
  expect(rowsOf(held.jobId).find((r) => r.turnIndex === null)?.personId).toBe(
    main
  );
  expect(
    turnRowsOf(held.jobId).map((r) => [r.turnIndex, r.personId, r.source])
  ).toEqual([
    [2, inferred, "inferred"],
    [3, inferred, "inferred"],
  ]);
});

test("an exact scope's qualifying voice wins and is stored when its label cannot split", () => {
  const expected = teach(first);
  const other = teach(second);
  const held = seed([first, second], [12, 12]);
  const profiles = readProfiles(env.db);
  const input = buildNamingInput({
    conversationId: held.id,
    people: [
      {
        aliases: [],
        canonicalRef: "person:aster",
        name: "Aster",
        personId: expected,
      },
      {
        aliases: [],
        canonicalRef: "person:bela",
        name: "Bela",
        personId: other,
      },
    ],
    snapshotRevision: 1,
    targets: [
      {
        clean: true,
        id: "turn",
        jobId: held.jobId,
        profiles: profiles.get("test@r1") ?? { people: [], strangers: [] },
        speakerLabel: "mixed",
        turnIndices: [0],
        vector: first,
      },
    ],
    turns: [0, 1].map((turnIndex) => ({
      jobId: held.jobId,
      speakerLabel: "mixed",
      text: "Made-up speech.",
      turnIndex,
    })),
  });
  env.db.transaction((tx) =>
    recognizeJob(tx, held.jobId, profiles, undefined, {
      attemptId: "synthetic",
      calibration: {
        confidence: 0.99,
        contradictionMargin: 0.2,
        contradictionScore: 0.8,
      },
      input,
      readings: [
        {
          basis: "context",
          confidence: 1,
          evidence: [{ quote: "Made-up speech.", turn: 0 }],
          personId: other,
          scopeId: "turn",
        },
      ],
      resolvePerson: (id) => id,
    })
  );
  expect(turnRowsOf(held.jobId)).toHaveLength(1);
  expect(turnRowsOf(held.jobId)[0]).toMatchObject({
    inference: null,
    personId: expected,
    source: "recognized",
    turnIndex: 0,
  });
});
