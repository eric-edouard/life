import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { countRows } from "@lifelog/db";
import {
  conversations,
  events,
  people as peopleTable,
  speakerAssignments,
  type Turn,
  transcriptionJobs,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { eq, sql } from "drizzle-orm";
import { createApp } from "./app";
import {
  assign as answerSpeaker,
  averageLinkage,
  expire,
  holdingConversations,
  keepServerSamples,
  loadTranscript,
  merge,
  recognize as recognizeJob,
  regroup,
  sweep,
  uncleanTurn,
  voiceUpkeep,
  weighProfiles,
} from "./people";
import { services } from "./services";
import { centroid } from "./speakers";
import {
  fakeSpeechService,
  mapJob,
  OWNER_TOKEN,
  seedTranscript,
  testConfig,
  testDb,
} from "./testing";

const speech = fakeSpeechService();
let env: Awaited<ReturnType<typeof testDb>>;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  env = testDb();
  app = createApp(
    services(
      testConfig("http://localhost:1", {
        IDENTITY_SECRET: "identity-test-secret",
        IDENTITY_URL: `http://localhost:${speech.server.port}`,
      }),
      env.db
    )
  );
});
afterAll(() => {
  env.drop();
  speech.server.stop(true);
});
beforeEach(() => {
  env.reset();
  speech.busy = false;
});

const auth = { Authorization: `Bearer ${OWNER_TOKEN}` };

// A unit vector from sparse (axis, value) pairs.
function v(...entries: [number, number][]) {
  const out = new Array<number>(192).fill(0);
  for (const [axis, value] of entries) {
    out[axis] = value;
  }
  const norm = Math.hypot(...out);
  return out.map((x) => x / norm);
}
let axis = 100;
const stranger = () => {
  axis += 1;
  return v([axis, 1]);
};

const turn = (speakerId: string, start: number, end: number): Turn => ({
  end,
  speakerId,
  start,
  text: "…",
});

// A transcript in a conversation of its own, a day after the one before (never nearby).
let seeded = 0;
function transcript(turns: Turn[]) {
  const id = crypto.randomUUID();
  const jobId = seedTranscript(env.db, turns);
  const at = Date.parse("2026-09-01T00:00:00Z") + seeded * 86_400_000;
  seeded += 1;
  env.db
    .insert(conversations)
    .values({
      captureEndedAt: new Date(at + 3_600_000),
      captureStartedAt: new Date(at),
      id,
    })
    .run();
  mapJob(env.db, jobId, [[at, at + 3_600_000]]);
  return jobId;
}

// One turn's voice sample, as the server cuts it (excerpts.ts): 200 when kept, 422 for a turn that
// isn't clean, 404 for no such turn.
function upload(jobId: string, turnIndex: number, vector: number[]) {
  const t = loadTranscript(env.db, jobId);
  const spoken = t?.parsed.turns[turnIndex];
  if (!(t && spoken?.speakerId)) {
    return { status: 404 };
  }
  if (uncleanTurn(t.parsed, turnIndex)) {
    return { status: 422 };
  }
  // No conversation holds the job yet: the server cuts it later.
  const [conversationId] = holdingConversations(env.db, jobId);
  if (!conversationId) {
    return { status: 404 };
  }
  keepServerSamples(env.db, jobId, [
    {
      conversationId,
      durationSeconds: Math.min(30, spoken.end - spoken.start),
      embedding: vector,
      jobId,
      modelId: "test/ecapa",
      modelRevision: "r1",
      speakerLabel: spoken.speakerId,
      turnIndex,
    },
  ]);
  return { status: 200 };
}

// A job's speaker rows as stored, with the person's name.
const speakersOf = (jobId: string): Row[] =>
  env.db
    .select({ personName: peopleTable.name, row: speakerAssignments })
    .from(speakerAssignments)
    .leftJoin(peopleTable, eq(peopleTable.id, speakerAssignments.personId))
    .where(eq(speakerAssignments.jobId, jobId))
    .orderBy(
      speakerAssignments.speakerLabel,
      sql`${speakerAssignments.turnIndex} asc nulls first`
    )
    .all()
    .map(({ personName, row }) => ({ ...row, personName }));

// Two speakers alternating 5 s turns: 10 s of clean speech each.
function conversation(voice0: number[], voice1: number[]) {
  const jobId = transcript([
    turn("speaker_0", 0, 5),
    turn("speaker_1", 5, 10),
    turn("speaker_0", 10, 15),
    turn("speaker_1", 15, 20),
  ]);
  const uploads = [voice0, voice1, voice0, voice1].map((voice, i) =>
    upload(jobId, i, voice)
  );
  expect(uploads.map((r) => r.status)).toEqual([200, 200, 200, 200]);
  return jobId;
}

interface Row {
  candidateId: string | null;
  candidates: unknown;
  mixed: boolean;
  personId: string | null;
  personName: string | null;
  score: number | null;
  source: string;
  speakerLabel: string;
  status: string;
  turnIndex: number | null;
}
interface Person {
  aliases: string[];
  id: string;
  name: string;
}
interface Evidence {
  jobId: string;
  turnIndex: number;
}

function recognize(jobId: string) {
  expect(recognizeJob(env.db, jobId)).not.toBeNull();
  return speakersOf(jobId);
}

async function assign(
  jobId: string,
  label: string,
  body: Record<string, unknown>
) {
  const res = await app.request(`/transcripts/${jobId}/speakers/${label}`, {
    body: JSON.stringify(body),
    headers: { ...auth, "Content-Type": "application/json" },
    method: "PUT",
  });
  expect(res.status).toBe(200);
  return speakersOf(jobId);
}

// Every person, by name, with their voice evidence in turn order.
const people = () => {
  const all = env.db.select().from(peopleTable).orderBy(peopleTable.name).all();
  const evidence = env.db
    .select({
      jobId: voiceSamples.jobId,
      personId: voiceProfiles.personId,
      turnIndex: voiceSamples.turnIndex,
    })
    .from(voiceProfiles)
    .innerJoin(voiceSamples, eq(voiceSamples.id, voiceProfiles.sampleId))
    .orderBy(voiceSamples.jobId, voiceSamples.turnIndex)
    .all();
  return all.map((p) => ({
    ...p,
    evidence: evidence.filter(
      (e): e is Evidence & { personId: string } => e.personId === p.id
    ),
  }));
};
const speaker = (rows: Row[], label: string) =>
  rows.find((r) => r.speakerLabel === label && r.turnIndex === null);

// The owner names speaker_0 of a fresh conversation: 2 turns of evidence.
async function enroll(name: string, voice: number[]) {
  const jobId = conversation(voice, stranger());
  const rows = await assign(jobId, "speaker_0", {
    target: { id: randomUUID(), kind: "new", name },
  });
  return { jobId, personId: speaker(rows, "speaker_0")?.personId ?? "" };
}

test("recognition matches a known voice and never enrols anything", async () => {
  const clara = await enroll("Clara", v([0, 1]));
  const jobId = conversation(v([0, 1], [5, 0.2]), stranger());
  const jobsBefore = countRows(env.db, transcriptionJobs);

  const rows = recognize(jobId);
  expect(speaker(rows, "speaker_0")).toMatchObject({
    personId: clara.personId,
    personName: "Clara",
    source: "recognized",
    status: "person",
  });
  expect(speaker(rows, "speaker_1")?.status).toBe("unknown");

  const all = people();
  expect(all.map((p) => p.name)).toEqual(["Clara"]);
  expect(all[0]?.evidence.every((e) => e.jobId === clara.jobId)).toBe(true);
  expect(all[0]?.evidence).toHaveLength(2);
  expect(countRows(env.db, transcriptionJobs)).toBe(jobsBefore);
});

test("a match needs both the threshold and a margin over the runner-up", async () => {
  await enroll("Carol", v([2, 1]));
  await enroll("Dana", v([2, 1], [3, 0.5])); // cosine 0.89 to Carol
  const jobId = conversation(v([2, 1], [3, 0.25]), v([9, 1]));

  const rows = recognize(jobId);
  const between = speaker(rows, "speaker_0");
  expect(between?.status).toBe("unknown");
  expect(between?.score).toBeGreaterThan(0.9); // close to both, so ambiguous
  expect(speaker(rows, "speaker_1")?.status).toBe("unknown");
});

test("the owner split in two less alike voices keeps both halves", async () => {
  const me = await enroll("Dave (Me)", v([0, 1]));
  env.db
    .update(peopleTable)
    .set({ isOwner: true })
    .where(eq(peopleTable.id, me.personId))
    .run();
  // Both match him (0.67 and 0.64) but are only 0.43 alike: Scribe split him, not two people.
  const jobId = conversation(v([0, 1], [5, 1.1]), v([0, 1], [6, 1.2]));
  const rows = recognize(jobId);
  expect(speaker(rows, "speaker_0")?.personId).toBe(me.personId);
  expect(speaker(rows, "speaker_1")?.personId).toBe(me.personId);
});

// A conversation of `voice` and a stranger, captured `minutes` into one evening.
const evening = Date.parse("2026-10-12T19:38:00Z");
function recording(voice: number[], minutes: number) {
  const jobId = conversation(voice, stranger());
  const holder = holdingConversations(env.db, jobId)[0] ?? "";
  const start = evening + minutes * 60_000;
  env.db
    .update(conversations)
    .set({
      captureEndedAt: new Date(start + 20_000),
      captureStartedAt: new Date(start),
    })
    .where(eq(conversations.id, holder))
    .run();
  mapJob(env.db, jobId, [[start, start + 20_000]]);
  return jobId;
}

test("a voice too close to two people is the one of them named nearby", async () => {
  const carol = await enroll("Carol", v([2, 1]));
  const dana = await enroll("Dana", v([2, 1], [3, 0.5])); // cosine 0.89 to Carol
  // 0.98 to Dana and 0.97 to Carol: ambiguous on profiles alone.
  const unsure = v([2, 1], [3, 0.25]);
  // Clear matches of Carol (0.70) and Dana (0.80) that sound unlike it (0.61, 0.65): presence only.
  const carolLike = v([2, 0.7], [3, -0.3], [9, 0.648]);
  const danaLike = v([2, 0.3], [3, 0.6]);
  const named = (jobId: string) => speaker(recognize(jobId), "speaker_0");

  const alone = recording(unsure, 0);
  expect(named(alone)?.personId).toBeNull();
  // Carol named nearby, but the voice is nearer Dana: still unknown.
  expect(named(recording(carolLike, 20))?.personId).toBe(carol.personId);
  expect(named(alone)?.personId).toBeNull();
  // Both named nearby: still too close to call.
  expect(named(recording(danaLike, 30))?.personId).toBe(dana.personId);
  expect(named(alone)?.personId).toBeNull();
  // Later, only Dana is around: the voice is hers, with its profile score and margin kept.
  const later = recording(unsure, 300);
  named(recording(danaLike, 310));
  expect(named(later)).toMatchObject({ personId: dana.personId });
  expect(named(later)?.score).toBeGreaterThan(0.97);
  // A name given this way names nobody else: near only that voice, the same voice stays unknown.
  expect(named(recording(unsure, 258))?.personId).toBeNull();
});

test("a voice that misses its profile takes the name of the same voice minutes away, never by a chain", async () => {
  const dave = await enroll("Dave", v([40, 1]));
  // 0.86 to the profile: named. Then 0.60 to the profile but 0.88 to that voice: the same
  // evening, the same person. Then 0.25 to the profile and 0.86 to the second voice only.
  const first = recording(v([40, 1], [41, 0.6]), 0);
  const second = recording(v([40, 0.5], [41, 0.6], [42, 0.3]), 30);
  const third = recording(v([40, 0.2], [41, 0.5], [42, 0.6]), 60);
  const later = recording(v([40, 0.5], [41, 0.6], [42, 0.3]), 300);

  expect(speaker(recognize(first), "speaker_0")?.personId).toBe(dave.personId);
  const named = speaker(recognize(second), "speaker_0");
  expect(named).toMatchObject({
    personId: dave.personId,
    source: "recognized",
  });
  expect(named?.score).toBeLessThan(0.6);
  // Only the second voice is near the third, and a name given this way names nobody else.
  expect(speaker(recognize(third), "speaker_0")?.personId).toBeNull();
  // Hours later the same voice is just a stranger again.
  expect(speaker(recognize(later), "speaker_0")?.personId).toBeNull();
  // A voice that only just matched the profile (0.62) passes nothing on: 0.94 alike, 0.47 to
  // the profile, still unnamed (a guest matched Marie-Jo's thin profile at 0.60 on Oct 11).
  const borderline = recording(v([40, 0.62], [43, 0.785]), 150);
  const guest = recording(v([40, 0.45], [43, 0.8], [44, 0.3]), 160);
  expect(speaker(recognize(borderline), "speaker_0")?.personId).toBe(
    dave.personId
  );
  expect(speaker(recognize(guest), "speaker_0")?.personId).toBeNull();
});

test("owner assignments survive re-recognition", async () => {
  await enroll("Clara", v([0, 1]));
  const jobId = conversation(v([0, 1]), stranger());
  expect(speaker(recognize(jobId), "speaker_0")?.status).toBe("person");

  await assign(jobId, "speaker_0", { target: { kind: "unknown" } });
  await assign(jobId, "speaker_1", {
    target: { id: randomUUID(), kind: "new", name: "Bob" },
  });
  const rows = recognize(jobId);
  expect(speaker(rows, "speaker_0")).toMatchObject({
    source: "owner",
    status: "unknown",
  });
  expect(speaker(rows, "speaker_1")).toMatchObject({
    personName: "Bob",
    source: "owner",
  });
});

test("a single-turn correction moves exactly that turn's evidence", async () => {
  const clara = await enroll("Clara", v([0, 1]));
  const evidenceOf = (name: string) =>
    people()
      .find((p) => p.name === name)
      ?.evidence.map((e) => e.turnIndex);

  // Turn 2 was really Bob.
  await assign(clara.jobId, "speaker_0", {
    target: { id: randomUUID(), kind: "new", name: "Bob" },
    turnIndex: 2,
  });
  expect(evidenceOf("Clara")).toEqual([0]);
  expect(evidenceOf("Bob")).toEqual([2]);

  // Later the whole speaker is set to unknown: Bob keeps the corrected turn.
  await assign(clara.jobId, "speaker_0", { target: { kind: "unknown" } });
  expect(evidenceOf("Clara")).toEqual([]);
  expect(evidenceOf("Bob")).toEqual([2]);
});

test("media is never a voice: it drops the scope's evidence and survives recognition", async () => {
  const clara = await enroll("Clara", v([0, 1]));
  const evidence = () =>
    people()
      .find((p) => p.name === "Clara")
      ?.evidence.map((e) => e.turnIndex);
  expect(evidence()).toEqual([0, 2]);

  // Turn 2 was the TV.
  let rows = await assign(clara.jobId, "speaker_0", {
    target: { kind: "media" },
    turnIndex: 2,
  });
  expect(rows.find((r) => r.turnIndex === 2)).toMatchObject({
    personId: null,
    source: "owner",
    status: "media",
  });
  expect(evidence()).toEqual([0]);

  // Then all of speaker_0 and all of speaker_1 are media: no voice evidence is left.
  await assign(clara.jobId, "speaker_1", { target: { kind: "media" } });
  rows = await assign(clara.jobId, "speaker_0", { target: { kind: "media" } });
  expect(speaker(rows, "speaker_0")).toMatchObject({
    personId: null,
    source: "owner",
    status: "media",
  });
  expect(evidence()).toEqual([]);
  expect(countRows(env.db, voiceProfiles)).toBe(0);

  rows = recognize(clara.jobId);
  expect(speaker(rows, "speaker_0")?.status).toBe("media");
  expect(speaker(rows, "speaker_1")?.status).toBe("media");
  expect(countRows(env.db, voiceProfiles)).toBe(0);
});

test("merging moves evidence and assignments", async () => {
  const a = await enroll("Clara", v([0, 1]));
  const b = await enroll("Ali", v([0, 1], [7, 0.1]));
  const res = await app.request(`/people/${a.personId}/merge`, {
    body: JSON.stringify({ personId: b.personId }),
    headers: { ...auth, "Content-Type": "application/json" },
    method: "POST",
  });
  expect(res.status).toBe(200);
  const all = people();
  expect(all).toHaveLength(1);
  expect(all[0]?.evidence).toHaveLength(4);
  // The merged name stays one of hers.
  expect(all[0]?.aliases).toEqual(["Ali"]);
  const rows = speakersOf(b.jobId);
  expect(speaker(rows, "speaker_0")?.personId).toBe(a.personId);
});

test("unclean turns are refused and short speakers stay unknown", async () => {
  await enroll("Clara", v([0, 1]));
  const messy = transcript([
    turn("speaker_0", 0, 5),
    turn("speaker_1", 4, 9), // overlaps turn 0
    turn("speaker_0", 9, 10), // too short
    turn("speaker_0", 10, 15),
  ]);
  expect(upload(messy, 0, v([0, 1])).status).toBe(422);
  expect(upload(messy, 2, v([0, 1])).status).toBe(422);
  expect(upload(messy, 9, v([0, 1])).status).toBe(404);
  expect(upload(messy, 3, v([0, 1])).status).toBe(200);
  // A word the provider stretched over 6 s: what it covers wasn't transcribed.
  const stretched = seedTranscript(
    env.db,
    [turn("speaker_0", 0, 8)],
    [
      {
        end: 1,
        logprob: null,
        spacing: "",
        speakerId: "speaker_0",
        start: 0,
        text: "Oui",
      },
      {
        end: 8,
        logprob: null,
        spacing: " ",
        speakerId: "speaker_0",
        start: 1.5,
        text: "donc",
      },
    ]
  );
  expect(upload(stretched, 0, v([0, 1])).status).toBe(422);

  const rows = recognize(messy); // 5 s of clean speech < 8 s
  expect(speaker(rows, "speaker_0")).toMatchObject({
    score: null,
    status: "unknown",
  });
});

test("a recurring unnamed voice becomes a candidate at night, not a person", () => {
  const voice = v([11, 1]);
  const first = conversation(voice, stranger());
  recognize(first);
  const second = conversation(voice, stranger());
  // Grouped only by the nightly regroup.
  expect(speaker(recognize(second), "speaker_0")?.status).toBe("unknown");
  regroup(env.db);
  const candidate = speaker(speakersOf(second), "speaker_0");
  expect(candidate).toMatchObject({ personId: null, status: "candidate" });
  const earlier = speakersOf(first);
  expect(speaker(earlier, "speaker_0")?.candidateId).toBe(
    candidate?.candidateId ?? "missing"
  );
  expect(people()).toEqual([]);
});

test("renaming keeps the evidence and refuses blank names and strangers", async () => {
  const a = await enroll("Clara", v([0, 1]));
  const rename = (id: string, name: string) =>
    app.request(`/people/${id}`, {
      body: JSON.stringify({ name }),
      headers: { ...auth, "Content-Type": "application/json" },
      method: "PATCH",
    });
  const res = await rename(a.personId, "  Alicia ");
  expect(res.status).toBe(200);
  const renamed = (await res.json()) as Person;
  expect(renamed.name).toBe("Alicia");
  expect(people()[0]?.evidence).toHaveLength(2);
  expect((await rename(a.personId, "   ")).status).toBe(400);
  expect((await rename(crypto.randomUUID(), "Bob")).status).toBe(404);
  expect(people().map((p) => p.name)).toEqual(["Alicia"]);

  // Other names: the whole list, each once, never the name itself; a rename keeps them.
  const called = await app.request(`/people/${a.personId}`, {
    body: JSON.stringify({ aliases: ["Ali", " ali ", "Alicia", "Lissy"] }),
    headers: { ...auth, "Content-Type": "application/json" },
    method: "PATCH",
  });
  expect(((await called.json()) as Person).aliases).toEqual(["Ali", "Lissy"]);
  expect(
    ((await (await rename(a.personId, "Clara")).json()) as Person).aliases
  ).toEqual(["Ali", "Lissy"]);
});

test("average linkage never chains two different voices through a middle one", () => {
  const a = v([0, 1]);
  const between = v([0, 1], [1, 1]);
  const b = v([1, 1]);
  // a~between and between~b are 0.71 alike, a~b 0: one pair, never a group of three.
  const [only, ...rest] = averageLinkage([a, between, b], 0.6);
  expect(rest).toEqual([]);
  expect(only).toHaveLength(2);
  expect(averageLinkage([a, a, b, b], 0.6)).toEqual([
    [0, 1],
    [2, 3],
  ]);
});

test("the sweep names old conversations once the owner names the voice", async () => {
  const voice = v([20, 1]);
  const old = conversation(voice, stranger());
  expect(speaker(recognize(old), "speaker_0")?.status).toBe("unknown");
  const { jobId: enrolled } = await enroll("Hervé", voice);
  // Settled before the sweep, so only the old conversation can change.
  sweep(env.db);
  env.db
    .delete(speakerAssignments)
    .where(eq(speakerAssignments.jobId, old))
    .run();
  env.db
    .insert(speakerAssignments)
    .values({
      jobId: old,
      source: "recognized",
      speakerLabel: "speaker_0",
      status: "unknown",
    })
    .run();

  const before = env.db.select().from(speakerAssignments).all();
  const result = sweep(env.db);
  expect(result.changed).toBe(1);
  expect(enrolled).not.toBe(old);
  const rows = recognize(old);
  expect(speaker(rows, "speaker_0")).toMatchObject({
    personName: "Hervé",
    source: "recognized",
  });
  // Nothing else was rewritten, and a second sweep writes nothing.
  const after = env.db.select().from(speakerAssignments).all();
  const untouched = before.filter((r) => r.jobId !== old);
  expect(after.filter((r) => r.jobId !== old)).toEqual(untouched);
  expect(sweep(env.db).changed).toBe(0);
});

test("a profile is one exemplar per conversation, of its clips of 3 s or more", () => {
  const row = (
    conversationId: string,
    embedding: number[],
    durationSeconds = 5
  ) => ({
    conversationId,
    durationSeconds,
    embedding,
    isOwner: false,
    modelId: "test/ecapa",
    modelRevision: "r1",
    personId: "clara",
    sampleId: randomUUID(),
  });
  const [profile] =
    weighProfiles([
      row("dinner", v([30, 1])),
      row("dinner", v([31, 1])),
      row("call", v([32, 1])),
      row("call", v([33, 1]), 2),
    ]).get("test/ecapa@r1") ?? [];
  expect(profile?.exemplars).toEqual([
    centroid([v([30, 1]), v([31, 1])]),
    v([32, 1]),
  ]);
});

test("regrouping splits a group that drifted", () => {
  const a = v([40, 1]);
  const b = v([41, 1]);
  const jobs = [
    conversation(a, stranger()),
    conversation(a, stranger()),
    conversation(b, stranger()),
  ];
  jobs.map(recognize);
  // Force one group over all three, as the old chaining could.
  env.db
    .update(speakerAssignments)
    .set({ candidateId: crypto.randomUUID(), status: "candidate" })
    .where(eq(speakerAssignments.speakerLabel, "speaker_0"))
    .run();
  expect(regroup(env.db)).toBe(1);
  const rows = env.db
    .select()
    .from(speakerAssignments)
    .where(eq(speakerAssignments.speakerLabel, "speaker_0"))
    .all();
  const byJob = new Map(rows.map((r) => [r.jobId, r]));
  expect(byJob.get(jobs[0] ?? "")?.candidateId).toBe(
    byJob.get(jobs[1] ?? "")?.candidateId ?? "missing"
  );
  expect(byJob.get(jobs[2] ?? "")).toMatchObject({
    candidateId: null,
    status: "unknown",
  });
});

test("expiry deletes old voice data that is nobody's evidence and keeps labels", async () => {
  const voice = v([50, 1]);
  const { jobId: enrolled } = await enroll("Mira", voice);
  const later = conversation(voice, stranger());
  expect(speaker(recognize(later), "speaker_0")?.personName).toBe("Mira");

  env.db
    .update(voiceSamples)
    .set({
      createdAt: new Date(Date.now() - 31 * 24 * 3600 * 1000),
    })
    .run();
  // Mira's 2 evidence clips stay; the 6 others go.
  expect(expire(env.db)).toBe(6);
  expect(countRows(env.db, voiceSamples)).toBe(2);
  expect(countRows(env.db, voiceProfiles)).toBe(2);
  // Without voice data, the later conversation keeps its name through a sweep.
  sweep(env.db);
  const rows = recognize(later);
  expect(speaker(rows, "speaker_0")?.personName).toBe("Mira");
  expect(enrolled).toBeTruthy();
});

test("the owner's own turns inside another speaker become his, with a turn sampled later too", async () => {
  const me = await enroll("Dave (Me)", v([60, 1]));
  env.db
    .update(peopleTable)
    .set({ isOwner: true })
    .where(eq(peopleTable.id, me.personId))
    .run();
  const guest = v([61, 1]);
  // speaker_1 is mostly a guest, with two of the owner's turns (one of them short) and one not
  // sampled yet.
  const jobId = transcript([
    turn("speaker_1", 0, 5),
    turn("speaker_1", 5, 10),
    turn("speaker_1", 10, 15),
    turn("speaker_1", 15, 20),
    turn("speaker_1", 20, 21.6),
    turn("speaker_1", 25, 30),
    turn("speaker_1", 30, 35),
  ]);
  const holder = holdingConversations(env.db, jobId)[0] ?? "";
  const anHourAgo = Date.now() - 3_600_000;
  env.db
    .update(conversations)
    .set({
      captureEndedAt: new Date(anHourAgo + 35_000),
      captureStartedAt: new Date(anHourAgo),
    })
    .where(eq(conversations.id, holder))
    .run();
  mapJob(env.db, jobId, [[anHourAgo, anHourAgo + 35_000]]);
  const voices = [guest, v([60, 1]), guest, guest, v([60, 1]), guest];
  voices.map((voice, i) => upload(jobId, i, voice));

  const rows = recognize(jobId);
  const turns = (r: Row[]) =>
    r.filter((x) => x.turnIndex !== null).map((x) => [x.turnIndex, x.personId]);
  expect(turns(rows)).toEqual([
    [1, me.personId],
    [4, me.personId],
  ]);
  // The rest is one other voice, judged without his turns.
  expect(speaker(rows, "speaker_1")).toMatchObject({ personId: null });
  // The last turn, sampled later: his too.
  upload(jobId, 6, v([60, 1]));
  expect(turns(recognize(jobId))).toEqual([
    [1, me.personId],
    [4, me.personId],
    [6, me.personId],
  ]);

  // The owner's correction of one moved turn wins, through every later run.
  await assign(jobId, "speaker_1", {
    target: { id: randomUUID(), kind: "new", name: "Guest" },
    turnIndex: 6,
  });
  const corrected = recognize(jobId);
  expect(corrected.find((r) => r.turnIndex === 6)?.source).toBe("owner");
  // Without voice data, the moved turn stays his.
  env.db
    .update(voiceSamples)
    .set({ createdAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) })
    .where(eq(voiceSamples.jobId, jobId))
    .run();
  expire(env.db);
  sweep(env.db);
  expect(turns(recognize(jobId))).toContainEqual([1, me.personId]);
});

// Oct 13: the owner's "Several people" marked voices mixed, and the sweep 60 s later recomputed the
// mark away. Oct 14: sweeps wrote score-less "unknown" rows for transcripts with no samples yet,
// which let summaries start before recognition.
test("a sweep keeps a mixed mark, and writes nothing for a transcript without samples", () => {
  const mixed = conversation(v([30, 1]), stranger());
  recognize(mixed);
  env.db
    .update(speakerAssignments)
    .set({ mixed: true })
    .where(eq(speakerAssignments.jobId, mixed))
    .run();
  const bare = transcript([turn("speaker_0", 0, 5), turn("speaker_1", 5, 10)]);
  sweep(env.db);
  const rows = env.db.select().from(speakerAssignments).all();
  expect(rows.filter((r) => r.jobId === mixed).every((r) => r.mixed)).toBe(
    true
  );
  expect(rows.filter((r) => r.jobId === bare)).toEqual([]);
});

// Oct 15: "several people" named nobody, so the voice's words stayed no one's. Now the owner says
// who is in it, and each sampled turn is decided among them alone.
test("a voice of several people: each sampled turn among the owner's candidates, once", async () => {
  const me = await enroll("Dave", v([40, 1]));
  env.db
    .update(peopleTable)
    .set({ isOwner: true })
    .where(eq(peopleTable.id, me.personId))
    .run();
  const clara = await enroll("Clara", v([41, 1]));
  const jobId = transcript(
    [0, 1, 2, 3, 4].map((i) => turn("speaker_0", i * 5, i * 5 + 5))
  );
  // Me, Clara, someone else, a weak Clara (0.45 alike).
  const voices = [
    v([40, 1]),
    v([41, 1]),
    stranger(),
    v([41, 0.45], [42, 0.89]),
  ];
  voices.map((voice, i) => upload(jobId, i, voice));
  const several = (unknown: boolean) =>
    answerSpeaker(env.db, {
      jobId,
      speakerLabel: "speaker_0",
      target: {
        candidates: { people: [me.personId, clara.personId], unknown },
        kind: "several",
        // naming-queue.ts picks the one to fall back on: Clara, in the closed set.
        personId: unknown ? null : clara.personId,
      },
      turnIndex: null,
    });
  const turns = (r: Row[]) =>
    r.filter((x) => x.turnIndex !== null).map((x) => [x.turnIndex, x.personId]);

  // With someone unknown too, the usual thresholds: the weak turn stays undecided, and nobody is
  // the voice as a whole.
  several(true);
  let rows = recognize(jobId);
  expect(turns(rows)).toEqual([
    [0, me.personId],
    [1, clara.personId],
  ]);
  expect(speaker(rows, "speaker_0")).toMatchObject({
    personId: null,
    source: "owner",
  });

  // A closed set takes the weak match; the undecided turn falls back on Clara, the one besides
  // the owner. Turns decided before stay as they were.
  several(false);
  rows = recognize(jobId);
  expect(turns(rows)).toEqual([
    [0, me.personId],
    [1, clara.personId],
    [3, clara.personId],
  ]);
  expect(speaker(rows, "speaker_0")).toMatchObject({
    personId: clara.personId,
    status: "person",
  });

  // Written once: a later profile change moves no turn.
  env.db
    .delete(voiceProfiles)
    .where(eq(voiceProfiles.personId, clara.personId))
    .run();
  sweep(env.db);
  expect(turns(speakersOf(jobId))).toEqual(turns(rows));

  // The voice is nobody's evidence, even its new samples.
  upload(jobId, 4, v([40, 1]));
  const evidence = people().flatMap((p) => p.evidence);
  expect(evidence.filter((e) => e.jobId === jobId)).toEqual([]);
  // A passage the owner confirms (the split after Done) is his row, and its person's evidence.
  answerSpeaker(env.db, {
    jobId,
    speakerLabel: "speaker_0",
    target: { kind: "person", personId: me.personId },
    turnIndex: 4,
  });
  const mine = people().find((p) => p.id === me.personId);
  expect(mine?.evidence).toContainEqual({
    jobId,
    personId: me.personId,
    turnIndex: 4,
  });

  // A candidate merged away stays, under the id they merged into, once (Clara into me).
  merge(env.db, me.personId, clara.personId);
  expect(speaker(speakersOf(jobId), "speaker_0")?.candidates).toEqual({
    people: [me.personId],
    unknown: false,
  });
});

test("the nightly upkeep runs once a night, across a restart too", () => {
  const night = new Date("2026-10-11T04:00:00Z");
  expect(
    voiceUpkeep(env.db).nightly(new Date("2026-10-11T02:00:00Z"))
  ).toBeNull();
  voiceUpkeep(env.db).nightly(night);
  // A deploy later that night.
  voiceUpkeep(env.db).nightly(new Date("2026-10-11T09:00:00Z"));
  voiceUpkeep(env.db).nightly(new Date("2026-10-12T04:00:00Z"));
  const runs = env.db
    .select({ day: sql<string>`${events.fields}->>'day'` })
    .from(events)
    .where(eq(events.name, "voices.upkeep"))
    .all();
  expect(runs.map((r) => r.day)).toEqual(["2026-10-11", "2026-10-12"]);
});
