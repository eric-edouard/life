import { afterAll, beforeEach, expect, test } from "bun:test";
import {
  speakerAssignments as assignments,
  intelligenceRuns,
  people,
  transcriptionJobs,
  transcripts,
  turns as turnRows,
  voiceProfiles,
  voiceSamples,
  type Word,
} from "@lifelog/db/schema";
import { asc, eq } from "drizzle-orm";
import { parseTranscript } from "./elevenlabs";
import { movedRows, rediarize } from "./rediarize";
import { seedConversation, testDb } from "./testing";

const { db, drop, reset } = testDb();
afterAll(drop);
beforeEach(reset);

const word = (
  text: string,
  start: number,
  end: number,
  speakerId: string
): Word => ({
  end,
  logprob: null,
  spacing: " ",
  speakerId,
  start,
  text,
});

// The speech service heard two voices; its speaker_0 holds a guest's turn and one of the owner's (turn 2).
const TURNS = [
  { end: 5, speakerId: "speaker_0", start: 0, text: "Hello there." },
  { end: 8, speakerId: "speaker_1", start: 5, text: "Hi." },
  { end: 12, speakerId: "speaker_0", start: 8, text: "Me again." },
  { end: 16, speakerId: "speaker_1", start: 12, text: "Bye." },
];
const WORDS = [
  word("Hello", 0, 1, "speaker_0"),
  word("Hi.", 5, 6, "speaker_1"),
  word("Me", 8, 9, "speaker_0"),
  word("Bye.", 12, 13, "speaker_1"),
];
// The corrected turns: the guest until 5 s, the owner after.
const DIARIZED = [
  { end: 5, speaker: "3", start: 0 },
  { end: 16, speaker: "7", start: 5 },
];

function seed() {
  const [guest, owner] = db
    .insert(people)
    .values([{ name: "Guest" }, { isOwner: true, name: "Owner" }])
    .returning()
    .all();
  if (!(guest && owner)) {
    throw new Error("no people");
  }
  const { id: conversationId, jobId } = seedConversation(db, TURNS, {
    ms: 16_000,
    words: WORDS,
  });
  db.update(transcripts)
    .set({
      raw: {
        language_code: "eng",
        language_probability: 1,
        words: WORDS.map((w) => ({
          end: w.end,
          speaker_id: w.speakerId,
          start: w.start,
          text: w.text,
          type: "word",
        })),
      },
    })
    .where(eq(transcripts.jobId, jobId))
    .run();
  db.insert(assignments)
    .values([
      {
        jobId,
        personId: guest.id,
        source: "owner",
        speakerLabel: "speaker_0",
        status: "person",
      },
      {
        jobId,
        personId: owner.id,
        source: "owner",
        speakerLabel: "speaker_1",
        status: "person",
      },
    ])
    .run();
  const sample = db
    .insert(voiceSamples)
    .values({
      conversationId,
      durationSeconds: 4,
      embedding: [1, 0],
      jobId,
      modelId: "m",
      modelRevision: "r",
      speakerLabel: "speaker_0",
      turnIndex: 2,
    })
    .returning()
    .get();
  db.update(transcriptionJobs)
    .set({ transcriber: "speech" })
    .where(eq(transcriptionJobs.id, jobId))
    .run();
  return {
    conversationId,
    guest: guest.id,
    jobId,
    owner: owner.id,
    sample: sample.id,
  };
}

const ownerRows = (jobId: string) =>
  db
    .select()
    .from(assignments)
    .where(eq(assignments.jobId, jobId))
    .all()
    .filter((r) => r.source === "owner")
    .map((r) => [r.speakerLabel, r.turnIndex, r.personId])
    .sort((a, b) => String(a).localeCompare(String(b)));

test("the corrected turns relabel a stored speech transcript, its turns and indexes kept", () => {
  const { jobId } = seed();
  expect(rediarize(db, jobId, DIARIZED)).toBe("done");
  const row = db
    .select()
    .from(transcripts)
    .where(eq(transcripts.jobId, jobId))
    .get();
  expect(row?.parsed.turns.map((t) => [t.speakerId, t.text])).toEqual([
    ["speaker_0", "Hello there."],
    ["speaker_1", "Hi."],
    ["speaker_1", "Me again."],
    ["speaker_1", "Bye."],
  ]);
  expect(row?.parsed.words.map((w) => w.speakerId)).toEqual([
    "speaker_0",
    "speaker_1",
    "speaker_1",
    "speaker_1",
  ]);
  // A parser bump re-reads the same speakers from raw.
  expect(
    parseTranscript(row?.raw).transcript.words.map((w) => w.speakerId)
  ).toEqual(row?.parsed.words.map((w) => w.speakerId) ?? []);
  const cached = db
    .select()
    .from(turnRows)
    .where(eq(turnRows.jobId, jobId))
    .orderBy(asc(turnRows.turnIndex))
    .all();
  expect(cached.map((t) => [t.turnIndex, t.speakerLabel])).toEqual([
    [0, "speaker_0"],
    [1, "speaker_1"],
    [2, "speaker_1"],
    [3, "speaker_1"],
  ]);
  expect(db.select().from(voiceSamples).get()?.speakerLabel).toBe("speaker_1");
  expect(rediarize(db, jobId, DIARIZED)).toBe("unchanged");
});

test("an answer stays whole only on its own turns; the split-off turn is left to recognition", () => {
  const { guest, jobId, owner } = seed();
  rediarize(db, jobId, DIARIZED);
  // The guest's voice is clean (only turn 0); the owner's voice now also holds turn 2, so his answer
  // goes turn by turn on his own turns, and turn 2 (the guest's before) gets no answer.
  expect(ownerRows(jobId)).toEqual([
    ["speaker_0", null, guest],
    ["speaker_1", 1, owner],
    ["speaker_1", 3, owner],
  ]);
});

test("a sample split off its answered voice stops being that person's evidence", () => {
  const { guest, jobId, sample } = seed();
  db.insert(voiceProfiles).values({ personId: guest, sampleId: sample }).run();
  rediarize(db, jobId, DIARIZED);
  expect(db.select().from(voiceProfiles).all()).toEqual([]);
});

test("a several-people answer moves whole and leaves recognition's turn rows", () => {
  const row = {
    candidateId: null,
    candidates: null,
    id: "r",
    jobId: "j",
    margin: null,
    mixed: false,
    personId: "p",
    rechecked: false,
    score: null,
    source: "recognized" as const,
    speakerLabel: "speaker_1",
    status: "person" as const,
    turnIndex: 1,
    updatedAt: new Date(0),
  };
  const several = {
    ...row,
    candidates: { people: ["p", "q"], unknown: false },
    id: "s",
    personId: null,
    source: "owner" as const,
    turnIndex: null,
  };
  const moved = movedRows(
    [several, row],
    TURNS.map((t) => t.speakerId),
    ["speaker_0", "speaker_1", "speaker_1", "speaker_1"],
    new Map([
      ["speaker_0", "speaker_0"],
      ["speaker_1", "speaker_1"],
    ])
  );
  expect(moved.map((r) => [r.id, r.speakerLabel, r.turnIndex])).toEqual([
    ["s", "speaker_1", null],
    ["r", "speaker_1", 1],
  ]);
});

test("a turn's own answer keeps its turn", () => {
  const { jobId, owner } = seed();
  db.insert(assignments)
    .values({
      jobId,
      personId: owner,
      source: "owner",
      speakerLabel: "speaker_0",
      status: "person",
      turnIndex: 2,
    })
    .run();
  rediarize(db, jobId, DIARIZED);
  expect(ownerRows(jobId)).toContainEqual(["speaker_1", 2, owner]);
});

test("a summary run's guess and token follow their voice", () => {
  const { conversationId, jobId } = seed();
  db.insert(intelligenceRuns)
    .values({
      conversationId,
      model: "m",
      promptVersion: 1,
      provider: "codex",
      result: {
        speakerIdentities: [
          { jobId, name: "Guest", speakerLabel: "speaker_1" },
        ],
        speakerTokens: [{ jobId, speakerLabel: "speaker_1", token: "S1" }],
      },
      state: "valid",
      turns: [],
    })
    .run();
  // The owner speaks first here, so his voice (the stored speaker_1) becomes speaker_0.
  rediarize(db, jobId, [
    { end: 0.5, speaker: "o", start: 0 },
    { end: 5, speaker: "g", start: 0.5 },
    { end: 16, speaker: "o", start: 5 },
  ]);
  const result = db.select().from(intelligenceRuns).get()?.result as {
    speakerIdentities: { speakerLabel: string }[];
    speakerTokens: { speakerLabel: string }[];
  };
  expect(result.speakerIdentities[0]?.speakerLabel).toBe("speaker_0");
  expect(result.speakerTokens[0]?.speakerLabel).toBe("speaker_0");
});

test("refused without turns or for a job the speech service did not transcribe", () => {
  const { jobId } = seed();
  expect(rediarize(db, jobId, [])).toBe("refused");
  expect(rediarize(db, crypto.randomUUID(), DIARIZED)).toBe("refused");
  db.update(transcriptionJobs)
    .set({ transcriber: "scribe" })
    .where(eq(transcriptionJobs.id, jobId))
    .run();
  expect(rediarize(db, jobId, DIARIZED)).toBe("refused");
  db.update(transcriptionJobs)
    .set({ transcriber: "speech" })
    .where(eq(transcriptionJobs.id, jobId))
    .run();
  expect(rediarize(db, jobId, DIARIZED)).toBe("done");
});
