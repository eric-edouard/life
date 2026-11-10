import { afterAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  conversations,
  intelligenceRuns,
  people,
  speakerAssignments,
  voiceSamples,
} from "@lifelog/db/schema";
import { namingQueue } from "./naming-queue";
import { PROMPT_VERSION } from "./summary-calls";
import { seedConversation, storedResult, testDb } from "./testing";

const env = testDb();
afterAll(() => env.drop());
beforeEach(() => env.reset());
let seeded = 0;

// A voice heard without a single exchange with the owner, in an old conversation.
function overheard(words: number, kind = "live") {
  const owner = env.db
    .insert(people)
    .values({ isOwner: true, name: "Owner" })
    .returning()
    .get();
  const at = Date.parse("2025-01-01T00:00:00Z") + seeded * 3_600_000;
  seeded += 1;
  const voice = seedConversation(
    env.db,
    [{ end: 9, speakerId: "speaker_1", start: 0, text: "A long story" }],
    {
      at,
      words: Array.from({ length: words }, (_, i) => ({
        end: ((i + 1) * 9) / words,
        logprob: null,
        spacing: " ",
        speakerId: "speaker_1",
        start: (i * 9) / words,
        text: "word",
      })),
    }
  );
  env.db
    .insert(intelligenceRuns)
    .values({
      conversationId: voice.id,
      model: "test-model",
      promptVersion: PROMPT_VERSION,
      provider: "claude-code",
      result: {
        ...storedResult(0, 0),
        speakerIdentities: [
          {
            evidenceTurnIds: [],
            jobId: voice.jobId,
            kind,
            name: null,
            personId: null,
            speakerLabel: "speaker_1",
            withOwner: false,
          },
        ],
      },
      state: "valid",
      turns: [{ capturedAt: null, jobId: voice.jobId, turnIndex: 0 }],
    })
    .run();
  expect(owner).toBeDefined();
  return voice;
}

test("historical overheard cards need 300 words; media and brief strangers stay out", () => {
  const brief = overheard(299);
  const enough = overheard(300);
  overheard(500, "media");
  const cards = namingQueue(env.db).items();
  expect(cards.map((c) => c.id)).toEqual([`${enough.jobId}/speaker_1`]);
  expect(cards[0]?.clips).toHaveLength(1);
  expect(cards.some((c) => c.voices.some((v) => v.jobId === brief.jobId))).toBe(
    false
  );
});

test("word totals deduplicate a turn held by overlapping conversations", () => {
  const brief = overheard(299);
  const original = env.db.select().from(conversations).get();
  if (!original) {
    throw new Error("missing conversation");
  }
  env.db
    .insert(conversations)
    .values({ ...original, id: randomUUID() })
    .run();
  const group = randomUUID();
  env.db
    .insert(speakerAssignments)
    .values({
      candidateId: group,
      jobId: brief.jobId,
      source: "recognized",
      speakerLabel: "speaker_1",
      status: "candidate",
    })
    .run();
  expect(namingQueue(env.db).items()).toEqual([]);
});

test("cards rank playable first, then the words naming them unlocks; cache agrees", () => {
  const fewer = overheard(300);
  const more = overheard(400);
  const unplayable = overheard(500);
  // A stale sample refers to a turn absent from the live conversation: no playable clip.
  env.db
    .insert(voiceSamples)
    .values({
      conversationId: unplayable.id,
      durationSeconds: 9,
      embedding: [1, 0],
      jobId: unplayable.jobId,
      modelId: "test",
      modelRevision: "r1",
      speakerLabel: "speaker_1",
      turnIndex: 99,
    })
    .run();
  const queue = namingQueue(env.db);
  const cards = queue.items();
  expect(cards.map((c) => c.id)).toEqual(
    [more, fewer, unplayable].map((c) => `${c.jobId}/speaker_1`)
  );
  expect(cards.at(-1)?.clips).toEqual([]);
  expect(queue.items()).toEqual(namingQueue(env.db).items());
  expect(cards.map((c) => c.words)).toEqual([400, 300, 500]);
});
