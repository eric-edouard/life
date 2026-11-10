import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { countRows } from "@lifelog/db";
import {
  speakerAssignments as assignments,
  changeLog,
  lifePeopleSnapshot,
  namingAttempts,
  people,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { sha256Hex } from "./config";
import {
  readLifePeople,
  replaceLifePeople,
  resolveLifePerson,
} from "./life-people";
import { assign, merge, renamePerson, type Target } from "./people";
import { services } from "./services";
import { OWNER_TOKEN, seedConversation, testConfig, testDb } from "./testing";

let env: ReturnType<typeof testDb>;
beforeAll(() => {
  env = testDb();
});
afterAll(() => env.drop());
beforeEach(() => env.reset());

const person = (ref: string, personId: string | null = null) => ({
  aliases: [],
  name: ref,
  personId,
  ref,
});
const snapshot = (
  entries = [person("aster")],
  revision = 1,
  folds: Record<string, string> = {}
) => ({
  complete: true as const,
  folds,
  people: entries,
  revision,
  version: 1 as const,
});
function linked(ref: string) {
  const id = resolveLifePerson(env.db, `life:${ref}`);
  if (!id) {
    throw new Error("missing test person");
  }
  return id;
}
const conversation = () =>
  seedConversation(env.db, [
    { end: 10, speakerId: "speaker_0", start: 0, text: "Hello there." },
    { end: 20, speakerId: "speaker_0", start: 10, text: "We can begin." },
  ]);

function inferred(
  jobId: string,
  personId: string,
  turnIndex: number | null = null
) {
  env.db
    .insert(assignments)
    .values({
      inference: {
        attemptId: "attempt",
        basis: "context",
        confidence: 0.99,
        evidence: [{ jobId, quote: "Hello there.", turnIndex: 0 }],
        inputHash: "input",
        snapshotRevision: 1,
      },
      jobId,
      personId,
      source: "inferred",
      speakerLabel: "speaker_0",
      status: "person",
      turnIndex,
    })
    .run();
}

test("complete snapshots are monotonic, idempotent, strict and atomically replace eligibility", () => {
  expect(replaceLifePeople(env.db, snapshot())).toEqual({
    changed: true,
    revision: 1,
  });
  const id = linked("aster");
  expect(replaceLifePeople(env.db, snapshot())).toEqual({
    changed: false,
    revision: 1,
  });
  expect(countRows(env.db, people)).toBe(1);
  expect(() => replaceLifePeople(env.db, snapshot([], 0))).toThrow();
  expect(() => replaceLifePeople(env.db, snapshot([], 1))).toThrow();
  expect(() =>
    replaceLifePeople(env.db, { ...snapshot([], 2), complete: false })
  ).toThrow();
  expect(readLifePeople(env.db)?.people[0]?.ref).toBe("aster");
  expect(resolveLifePerson(env.db, id)).toBe(id);
  expect(env.db.select().from(people).get()?.creationSource).toBe("inferred");
  replaceLifePeople(env.db, snapshot([], 2));
  expect(resolveLifePerson(env.db, "life:aster")).toBeNull();
  expect(countRows(env.db, people)).toBe(0);
});

for (const state of ["named", "abstained"] as const) {
  test(`higher revision with identical people preserves ${state} cache and assignments`, () => {
    replaceLifePeople(env.db, snapshot());
    const personId = linked("aster");
    const { id: conversationId, jobId } = conversation();
    inferred(jobId, personId);
    env.db
      .insert(namingAttempts)
      .values({
        attempts: 2,
        call: { inputTokens: 10, outputTokens: 5, text: "synthetic" },
        conversationId,
        inputHash: "input",
        model: "synthetic",
        policyHash: "policy",
        promptHash: "prompt",
        result: { readings: state === "named" ? [{ personId }] : [] },
        snapshotRevision: 1,
        state,
      })
      .run();
    const attempt = env.db.select().from(namingAttempts).get();
    const rows = env.db.select().from(assignments).all();
    const changes = countRows(env.db, changeLog);
    const hash = readLifePeople(env.db)?.hash;
    expect(replaceLifePeople(env.db, snapshot([person("aster")], 2))).toEqual({
      changed: false,
      revision: 2,
    });
    expect(readLifePeople(env.db)).toMatchObject({ hash, revision: 2 });
    expect(env.db.select().from(namingAttempts).get()).toEqual(attempt);
    expect(env.db.select().from(assignments).all()).toEqual(rows);
    expect(countRows(env.db, changeLog)).toBe(changes);
  });
}

test("owner rename survives Life removal without changing inferred creation provenance", () => {
  replaceLifePeople(env.db, snapshot());
  const id = linked("aster");
  renamePerson(env.db, id, { aliases: ["Ash"], name: "Aster revised" });
  replaceLifePeople(env.db, snapshot([], 2));
  const retained = env.db.select().from(people).where(eq(people.id, id)).get();
  expect(retained).toMatchObject({
    aliases: ["Ash"],
    creationSource: "inferred",
    lifeRef: null,
    name: "Aster revised",
    nameSource: "owner",
  });
});

test("provisional names refresh until owner confirmation establishes name authority", () => {
  replaceLifePeople(env.db, snapshot());
  const id = linked("aster");
  replaceLifePeople(
    env.db,
    snapshot([{ ...person("aster"), name: "Aster revised" }], 2)
  );
  expect(env.db.select().from(people).get()?.name).toBe("Aster revised");
  const { jobId } = conversation();
  assign(env.db, {
    jobId,
    speakerLabel: "speaker_0",
    target: { kind: "person", personId: id },
    turnIndex: 0,
  });
  replaceLifePeople(
    env.db,
    snapshot([{ ...person("aster"), name: "Stale name" }], 3)
  );
  expect(env.db.select().from(people).get()).toMatchObject({
    creationSource: "inferred",
    name: "Aster revised",
    nameSource: "owner",
  });
});

test("automatic folds preserve an owner's old name over a provisional canonical name", () => {
  const canonical = env.db
    .insert(people)
    .values({
      creationSource: "inferred",
      name: "Provisional guess",
      nameSource: "inferred",
    })
    .returning()
    .get();
  const old = env.db
    .insert(people)
    .values({ aliases: ["Ash"], name: "Aster" })
    .returning()
    .get();
  replaceLifePeople(
    env.db,
    snapshot([person("old", old.id), person("canonical", canonical.id)], 1, {
      old: "canonical",
    })
  );
  expect(env.db.select().from(people).get()).toMatchObject({
    aliases: ["Ash"],
    creationSource: "inferred",
    id: canonical.id,
    name: "Aster",
    nameSource: "owner",
  });
});

test("automatic folds union owner aliases while keeping the canonical owner name", () => {
  const canonical = env.db
    .insert(people)
    .values({ aliases: ["Bir"], name: "Birch" })
    .returning()
    .get();
  const old = env.db
    .insert(people)
    .values({ aliases: ["Ash"], name: "Aster" })
    .returning()
    .get();
  merge(env.db, canonical.id, old.id);
  expect(env.db.select().from(people).get()).toMatchObject({
    aliases: ["Bir", "Ash", "Aster"],
    name: "Birch",
    nameSource: "owner",
  });
});

test("merging a provisional name teaches no owner name or alias", () => {
  const canonical = env.db
    .insert(people)
    .values({ name: "Birch" })
    .returning()
    .get();
  const provisional = env.db
    .insert(people)
    .values({
      aliases: ["Unconfirmed alias"],
      creationSource: "inferred",
      name: "Provisional guess",
      nameSource: "inferred",
    })
    .returning()
    .get();
  merge(env.db, canonical.id, provisional.id);
  expect(env.db.select().from(people).get()).toMatchObject({
    aliases: [],
    name: "Birch",
    nameSource: "owner",
  });
});

test("owner merge retargets an explicit Life link through later snapshots without changing truth", () => {
  const old = env.db.insert(people).values({ name: "Aster" }).returning().get();
  const into = env.db
    .insert(people)
    .values({ name: "Birch" })
    .returning()
    .get();
  replaceLifePeople(env.db, snapshot([person("aster", old.id)]));
  const { id: conversationId, jobId } = conversation();
  inferred(jobId, old.id);
  assign(env.db, {
    jobId,
    speakerLabel: "speaker_0",
    target: { kind: "person", personId: old.id },
    turnIndex: 0,
  });
  const sample = env.db
    .insert(voiceSamples)
    .values({
      conversationId,
      durationSeconds: 10,
      embedding: [1, 0],
      jobId,
      modelId: "synthetic",
      modelRevision: "1",
      speakerLabel: "speaker_0",
      turnIndex: 0,
    })
    .returning()
    .get();
  env.db
    .insert(voiceProfiles)
    .values({ personId: old.id, sampleId: sample.id })
    .run();
  merge(env.db, into.id, old.id);
  expect(env.db.select().from(people).get()).toMatchObject({
    id: into.id,
    lifeRef: "aster",
  });
  expect(env.db.select().from(voiceProfiles).get()?.personId).toBe(into.id);
  expect(
    env.db
      .select()
      .from(assignments)
      .all()
      .every((a) => a.personId === into.id)
  ).toBe(true);
  const refreshed = snapshot([person("aster", old.id), person("cedar")], 2);
  expect(replaceLifePeople(env.db, refreshed)).toEqual({
    changed: true,
    revision: 2,
  });
  expect(replaceLifePeople(env.db, { ...refreshed, revision: 3 })).toEqual({
    changed: false,
    revision: 3,
  });
  expect(linked("aster")).toBe(into.id);
  expect(
    readLifePeople(env.db)?.people.find((p) => p.ref === "aster")?.personId
  ).toBe(old.id);
  expect(env.db.select().from(voiceProfiles).get()?.personId).toBe(into.id);
});

test("removal drops inferred attribution and attempt results, preserving owner answers and voice evidence", () => {
  replaceLifePeople(env.db, snapshot());
  const id = linked("aster");
  const { id: conversationId, jobId } = conversation();
  inferred(jobId, id);
  assign(env.db, {
    jobId,
    speakerLabel: "speaker_0",
    target: { kind: "person", personId: id },
    turnIndex: 0,
  });
  const sample = env.db
    .insert(voiceSamples)
    .values({
      conversationId,
      durationSeconds: 10,
      embedding: [1, 0],
      jobId,
      modelId: "synthetic",
      modelRevision: "1",
      speakerLabel: "speaker_0",
      turnIndex: 0,
    })
    .returning()
    .get();
  if (!sample) {
    throw new Error("missing sample");
  }
  env.db
    .insert(voiceProfiles)
    .values({ personId: id, sampleId: sample.id })
    .run();
  env.db
    .insert(namingAttempts)
    .values({
      conversationId,
      inputHash: "input",
      model: "synthetic",
      policyHash: "policy",
      promptHash: "prompt",
      result: { named: true },
      snapshotRevision: 1,
      state: "named",
    })
    .run();
  replaceLifePeople(env.db, snapshot([], 2));
  expect(
    env.db
      .select()
      .from(assignments)
      .all()
      .map((a) => a.source)
  ).toEqual(["owner"]);
  expect(env.db.select().from(people).get()?.lifeRef).toBeNull();
  expect(countRows(env.db, voiceSamples)).toBe(1);
  expect(countRows(env.db, voiceProfiles)).toBe(1);
  expect(env.db.select().from(namingAttempts).get()?.result).toBeNull();
});

test("chained folds retarget the existing id when the canonical person is not in lifelog", () => {
  replaceLifePeople(env.db, snapshot([person("old")]));
  const id = linked("old");
  const { jobId } = conversation();
  inferred(jobId, id);
  const next = snapshot([person("canonical")], 2, {
    middle: "canonical",
    old: "middle",
  });
  replaceLifePeople(env.db, next);
  expect(linked("canonical")).toBe(id);
  expect(linked("old")).toBe(id);
  expect(env.db.select().from(assignments).get()?.personId).toBe(id);
  expect(countRows(env.db, people)).toBe(1);
  expect(replaceLifePeople(env.db, next).changed).toBe(false);
});

test("folds merge every named turn, candidates and legitimate evidence with owner names only", () => {
  const canonical = env.db
    .insert(people)
    .values({ name: "Birch" })
    .returning()
    .get();
  const old = env.db
    .insert(people)
    .values({
      creationSource: "inferred",
      name: "Aster",
      nameSource: "inferred",
    })
    .returning()
    .get();
  if (!old) {
    throw new Error("missing people");
  }
  const { id: conversationId, jobId } = conversation();
  inferred(jobId, old.id);
  assign(env.db, {
    jobId,
    speakerLabel: "speaker_0",
    target: { kind: "person", personId: old.id },
    turnIndex: 0,
  });
  env.db
    .insert(assignments)
    .values({
      candidates: { people: [old.id], unknown: true },
      jobId,
      source: "owner",
      speakerLabel: "several",
      status: "unknown",
    })
    .run();
  const sample = env.db
    .insert(voiceSamples)
    .values({
      conversationId,
      durationSeconds: 10,
      embedding: [1, 0],
      jobId,
      modelId: "synthetic",
      modelRevision: "1",
      speakerLabel: "speaker_0",
      turnIndex: 0,
    })
    .returning()
    .get();
  if (!sample) {
    throw new Error("missing sample");
  }
  env.db
    .insert(voiceProfiles)
    .values({ personId: old.id, sampleId: sample.id })
    .run();
  replaceLifePeople(
    env.db,
    snapshot([person("old", old.id), person("canonical", canonical.id)], 1, {
      old: "canonical",
    })
  );
  expect(countRows(env.db, people)).toBe(1);
  expect(env.db.select().from(people).get()?.aliases).toEqual(["Aster"]);
  expect(env.db.select().from(voiceProfiles).get()?.personId).toBe(
    canonical.id
  );
  expect(
    env.db
      .select()
      .from(assignments)
      .all()
      .every(
        (a) =>
          a.personId === canonical.id ||
          a.candidates?.people[0] === canonical.id
      )
  ).toBe(true);
  expect(readLifePeople(env.db)?.people.map((p) => p.ref)).toEqual([
    "canonical",
  ]);
  expect(
    env.db
      .select()
      .from(assignments)
      .all()
      .filter((a) => a.source === "owner")
  ).toHaveLength(2);
  expect(
    replaceLifePeople(
      env.db,
      snapshot([person("old", old.id), person("canonical", canonical.id)], 2, {
        old: "canonical",
      })
    )
  ).toEqual({ changed: false, revision: 2 });
  expect(countRows(env.db, people)).toBe(1);
  expect(env.db.select().from(voiceProfiles).get()?.personId).toBe(
    canonical.id
  );
  replaceLifePeople(
    env.db,
    snapshot(
      [
        person("old", old.id),
        person("canonical", canonical.id),
        person("latest"),
      ],
      3,
      { canonical: "latest", old: "canonical" }
    )
  );
  expect(linked("latest")).toBe(canonical.id);
  expect(env.db.select().from(voiceProfiles).get()?.personId).toBe(
    canonical.id
  );
});

test("a first snapshot cannot use a missing explicit old link as an applied fold", () => {
  const canonical = env.db
    .insert(people)
    .values({ lifeRef: "canonical", name: "Birch" })
    .returning()
    .get();
  expect(() =>
    replaceLifePeople(
      env.db,
      snapshot(
        [
          person("old", "00000000-0000-4000-8000-000000000001"),
          person("canonical", canonical.id),
        ],
        1,
        { old: "canonical" }
      )
    )
  ).toThrow("explicit lifelog person does not exist");
  expect(readLifePeople(env.db)).toBeUndefined();
});

test("explicit link conflicts and cyclic folds roll back the whole snapshot", () => {
  replaceLifePeople(env.db, snapshot());
  const aster = linked("aster");
  const other = env.db
    .insert(people)
    .values({ lifeRef: "unrelated", name: "Birch" })
    .returning()
    .get();
  expect(() =>
    replaceLifePeople(env.db, snapshot([person("aster", other.id)], 2))
  ).toThrow();
  expect(readLifePeople(env.db)?.revision).toBe(1);
  expect(
    env.db.select().from(people).where(eq(people.id, aster)).get()?.lifeRef
  ).toBe("aster");
  expect(() =>
    replaceLifePeople(
      env.db,
      snapshot([person("aster")], 2, { aster: "middle", middle: "aster" })
    )
  ).toThrow();
});

for (const target of [
  { kind: "unknown" },
  { kind: "media" },
  {
    candidates: { people: [], unknown: true },
    kind: "several",
    personId: null,
  },
] satisfies Target[]) {
  test(`owner ${target.kind} replaces inferred splits and invalidates attempts`, () => {
    const ghost = env.db
      .insert(people)
      .values({
        creationSource: "inferred",
        name: "Aster",
        nameSource: "inferred",
      })
      .returning()
      .get();
    if (!ghost) {
      throw new Error("missing person");
    }
    const { id: conversationId, jobId } = conversation();
    inferred(jobId, ghost.id, 1);
    env.db
      .insert(namingAttempts)
      .values({
        conversationId,
        inputHash: "input",
        model: "synthetic",
        policyHash: "policy",
        promptHash: "prompt",
        result: {},
        snapshotRevision: 1,
      })
      .run();
    assign(env.db, {
      jobId,
      speakerLabel: "speaker_0",
      target,
      turnIndex: null,
    });
    expect(
      env.db
        .select()
        .from(assignments)
        .all()
        .every((a) => a.source !== "inferred")
    ).toBe(true);
    expect(env.db.select().from(namingAttempts).get()?.result).toBeNull();
    expect(countRows(env.db, people)).toBe(0);
    replaceLifePeople(env.db, snapshot());
    expect(
      env.db
        .select()
        .from(assignments)
        .all()
        .some((a) => a.source === "owner")
    ).toBe(true);
  });
}

test("snapshot route accepts corrections and denies read/map tokens; partial requests cannot delete", async () => {
  const app = createApp(
    services(
      testConfig("http://localhost:1", {
        CORRECTIONS_TOKEN_HASH: sha256Hex("corrections"),
        MAP_TOKEN_HASH: sha256Hex("map"),
        READ_TOKEN_HASH: sha256Hex("read"),
      }),
      env.db,
      { intelligence: null, search: null }
    )
  );
  const request = (token: string, body: unknown) =>
    app.request("/life/people", {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "PUT",
    });
  expect((await request("read", snapshot())).status).toBe(403);
  expect((await request("map", snapshot())).status).toBe(403);
  expect((await request("corrections", snapshot())).status).toBe(200);
  const invalid = { ...snapshot([], 2), complete: false };
  expect((await request(OWNER_TOKEN, invalid)).status).toBe(400);
  expect(countRows(env.db, lifePeopleSnapshot)).toBe(1);
  expect((await request(OWNER_TOKEN, snapshot([], 0))).status).toBe(409);
  expect(readLifePeople(env.db)?.revision).toBe(1);
});
