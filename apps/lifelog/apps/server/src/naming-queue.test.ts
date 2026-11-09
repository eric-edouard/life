import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  alertPushToken,
  conversations,
  intelligenceRuns,
  people,
  speakerAssignments,
  type Turn,
  transcriptionJobs,
  transcripts,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { eq as is } from "drizzle-orm";
import type { PushRequest } from "./apns";
import { createApp } from "./app";
import { setOwnerTimeZone } from "./config";
import {
  answerVoices,
  cardClips,
  morningPush,
  queueCache,
} from "./naming-queue";
import { assign, sweep } from "./people";
import { services } from "./services";
import { PROMPT_VERSION } from "./summary-calls";
import {
  mapJob,
  OWNER_TOKEN,
  seedTranscript,
  storedResult,
  testConfig,
  testDb,
} from "./testing";

let env: Awaited<ReturnType<typeof testDb>>;
beforeAll(() => {
  env = testDb();
  setOwnerTimeZone("Asia/Jakarta");
});
afterAll(() => {
  setOwnerTimeZone(null);
  env.drop();
});
beforeEach(() => {
  env.reset();
  seeded = 0;
});

// Oct 10 at noon in the tests' zone (Asia/Jakarta, set below), and the next morning at 9.
const NOON = Date.parse("2026-10-10T05:00:00Z");
const NEXT_MORNING = new Date("2026-10-11T02:00:00Z");
// The whole naming queue.
const queued = () => queueCache(env.db).items();

// Conversations seeded in this test: each one starts an hour after the one before, so their
// words never overlap.
let seeded = 0;

// A conversation of `turns` (speaker, seconds) on DAY, its speaker_0 the owner, with a valid
// run that heard `identities` for its unnamed speakers.
function conversation(
  ownerId: string,
  speakers: string[],
  identities: Record<string, unknown>[] = [],
  kinds: Record<string, unknown>[] = [],
  start = NOON + seeded * 3_600_000
) {
  seeded += 1;
  const id = randomUUID();
  const turns: Turn[] = speakers.map((speakerId, i) => ({
    end: i * 10 + 9,
    speakerId,
    start: i * 10,
    text: `turn ${i}`,
  }));
  // One word a turn, its whole text.
  const words = turns.map((t) => ({ ...t, logprob: null, spacing: " " }));
  const jobId = seedTranscript(env.db, turns, words);
  env.db
    .insert(conversations)
    .values({
      captureEndedAt: new Date(start + 600_000),
      captureStartedAt: new Date(start),
      id,
    })
    .run();
  mapJob(env.db, jobId, [[start, start + turns.length * 10_000]]);
  env.db
    .insert(speakerAssignments)
    .values({
      jobId,
      personId: ownerId,
      source: "owner",
      speakerLabel: "speaker_0",
      status: "person",
    })
    .run();
  env.db
    .insert(intelligenceRuns)
    .values({
      conversationId: id,
      model: "claude-sonnet-5-5",
      promptVersion: PROMPT_VERSION,
      provider: "claude-code",
      result: {
        ...storedResult(0, turns.length - 1),
        speakerIdentities: identities.map((s) => ({ jobId, ...s })),
        speakerKinds: kinds.map((s) => ({ jobId, ...s })),
      },
      state: "valid",
      turns: turns.map((_, turnIndex) => ({
        capturedAt: null,
        jobId,
        turnIndex,
      })),
    })
    .run();
  return { id, jobId };
}

const identity = (fields: Record<string, unknown>) => ({
  evidenceTurnIds: [],
  kind: "live",
  name: null,
  personId: null,
  speakerLabel: "speaker_1",
  withOwner: true,
  ...fields,
});

// The owner and speaker_1 taking turns: 2 exchanges per pair of turns after the first.
const talk = (pairs: number) =>
  Array.from({ length: pairs * 2 }, (_, i) => `speaker_${i % 2}`);

function owner() {
  const [me] = env.db
    .insert(people)
    .values({ isOwner: true, name: "Dave (Me)" })
    .returning()
    .all();
  return me?.id ?? "";
}

test("a voice that talked with the owner is queued with the name heard; others are skipped", () => {
  const me = owner();
  const herve = conversation(me, talk(8), [
    identity({ evidenceTurnIds: [3], name: "Hervé" }),
  ]);
  // Overheard: never next to the owner.
  conversation(me, ["speaker_0", "speaker_0", "speaker_1", "speaker_1"]);
  // A loudspeaker, next to the owner but media.
  conversation(me, talk(8), [
    identity({ kind: "announcement", withOwner: false }),
  ]);
  // People nearby talking among themselves, between the owner's turns.
  conversation(me, talk(8), [identity({ withOwner: false })]);

  // Only Hervé's voice: the others are strangers or media.
  const items = queued();
  expect(items[0]?.clips.length).toBeGreaterThan(0);
  expect(items).toEqual([
    {
      clips: expect.any(Array),
      conversations: 1,
      evidence: [
        {
          at: new Date(NOON + 30_000).toISOString(),
          conversationId: herve.id,
          text: "turn 3",
        },
      ],
      exchanges: 15,
      id: `${herve.jobId}/speaker_1`,
      kind: "new_person",
      name: "Hervé",
      personId: null,
      seconds: 72,
      voices: [
        {
          conversationId: herve.id,
          jobId: herve.jobId,
          speakerLabel: "speaker_1",
        },
      ],
    },
  ]);
});

// Two conversations: one where the owner's people are heard naming "Hervé", one with a voice
// the summaries take for Marie-Jo.
function twoCards() {
  const me = owner();
  const [marie] = env.db
    .insert(people)
    .values({ name: "Marie-Jo" })
    .returning()
    .all();
  conversation(me, talk(8), [
    identity({ evidenceTurnIds: [1], name: "Hervé" }),
  ]);
  const nickname = conversation(me, talk(8), [
    identity({ personId: marie?.id }),
  ]);
  return nickname;
}

test("the morning pushes the queue's length once, the number the badge shows", async () => {
  twoCards();
  env.db.insert(alertPushToken).values({ pushToken: "abcdef" }).run();
  const sent: PushRequest[] = [];
  const queue = queueCache(env.db);
  const digest = morningPush(
    env.db,
    (request) => {
      sent.push(request);
      return Promise.resolve({ body: "", status: 200 });
    },
    "com.example.lifelog",
    queue
  );
  // 6:00: too early.
  expect(await digest.morning(new Date("2026-10-10T23:00:00Z"))).toBeNull();
  const made = await digest.morning(NEXT_MORNING);
  expect(made).toEqual({ count: queue.items().length });
  expect(made?.count).toBe(2);
  expect(await digest.morning(NEXT_MORNING)).toBeNull();
  // A restart the same morning sends nothing more.
  expect(
    await morningPush(env.db, null, "app", queue).morning(NEXT_MORNING)
  ).toBeNull();
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]?.body ?? "{}")).toMatchObject({
    aps: { alert: { body: "2 voices to name." } },
    peopleDigest: "2026-10-11",
  });
});

test("no voice waiting, no push", async () => {
  owner();
  env.db.insert(alertPushToken).values({ pushToken: "abcdef" }).run();
  let sent = 0;
  const digest = morningPush(
    env.db,
    () => {
      sent += 1;
      return Promise.resolve({ body: "", status: 200 });
    },
    "app",
    queueCache(env.db)
  );
  expect(await digest.morning(NEXT_MORNING)).toEqual({ count: 0 });
  expect(sent).toBe(0);
});

test("the kept queue is always the one built afresh", async () => {
  const queue = queueCache(env.db);
  twoCards();
  expect(queue.items()).toEqual(queued());
  const [first] = queue.items();
  answerVoices(env.db, first?.voices ?? [], { kind: "confirm", name: "Hervé" });
  expect(queue.items()).toHaveLength(1);
  expect(queue.items()).toEqual(queued());
  const me = env.db.select().from(people).where(is(people.isOwner, true)).get();
  conversation(me?.id ?? "", talk(8), [identity({ name: "Zoé" })]);
  expect(queue.items()).toHaveLength(2);
  expect(queue.items()).toEqual(queued());
  await sweep(env.db);
  expect(queue.items()).toEqual(queued());
});

test("answers are the owner's corrections, once each", () => {
  const nickname = twoCards();
  const items = queued();
  const voices = (kind: string) =>
    items.find((s) => s.kind === kind)?.voices ?? [];

  const confirmed = answerVoices(env.db, voices("new_person"), {
    kind: "confirm",
    name: "Hervé",
  });
  const owned = env.db.query.speakerAssignments
    .findMany({
      where: (a, { eq }) => eq(a.personId, confirmed?.personId ?? "missing"),
    })
    .sync();
  expect(owned.map((r) => r.source)).toEqual(["owner"]);

  const ignore = { kind: "ignore" } as const;
  expect(answerVoices(env.db, voices("known_person"), ignore)).toEqual({
    personId: null,
  });
  const ignored = env.db.query.speakerAssignments
    .findFirst({
      where: (a, { and, eq }) =>
        and(eq(a.jobId, nickname.jobId), eq(a.speakerLabel, "speaker_1")),
    })
    .sync();
  expect(ignored).toMatchObject({ source: "owner", status: "unknown" });
  // A video or TV: its speaker is media, so summaries and search leave it out.
  answerVoices(env.db, [{ jobId: nickname.jobId, speakerLabel: "speaker_1" }], {
    kind: "media",
  });
  expect(
    env.db.query.speakerAssignments
      .findFirst({
        where: (a, { and, eq }) =>
          and(eq(a.jobId, nickname.jobId), eq(a.speakerLabel, "speaker_1")),
      })
      .sync()
  ).toMatchObject({ source: "owner", status: "media" });
  // The queue skips both voices; a speaker that isn't one is no answer.
  expect(queued()).toEqual([]);
  expect(
    answerVoices(
      env.db,
      [{ jobId: nickname.jobId, speakerLabel: "speaker_9" }],
      ignore
    )
  ).toBeNull();
});

// A heard name may be someone else at the table: answering a card heard as "Nina" with Lea once
// made Nina Lea's alias, and every later "Nina" read as Lea. Names come from the owner only.
test("an answer teaches no name, and a typed nickname is the person", async () => {
  const me = owner();
  const [marie] = env.db
    .insert(people)
    .values({ aliases: ["Jojo"], name: "Marie-Jo" })
    .returning()
    .all();
  conversation(me, talk(8), [identity({ name: "Nina" })]);
  const card = queued().find((c) => c.name === "Nina");
  const app = createApp(services(testConfig("http://localhost:1"), env.db));
  const res = await app.request("/naming-queue/answer", {
    body: JSON.stringify({
      answer: { kind: "confirm", name: "Lea" },
      voices: card?.voices ?? [],
    }),
    headers: {
      Authorization: `Bearer ${OWNER_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  expect(res.status).toBe(200);
  expect(
    env.db.query.people
      .findMany()
      .sync()
      .map((p) => [p.name, p.aliases])
  ).toContainEqual(["Lea", []]);
  const { jobId } = conversation(me, talk(4));
  const typed = answerVoices(env.db, [{ jobId, speakerLabel: "speaker_1" }], {
    kind: "confirm",
    name: "jojo",
  });
  expect(typed).toEqual({ personId: marie?.id ?? "" });
});

test("an answer takes every voice of its card, past 100", async () => {
  const me = owner();
  conversation(me, talk(8), [identity({ name: "Nina" })]);
  const card = queued().find((c) => c.name === "Nina");
  const strangers = Array.from({ length: 100 }, () => ({
    jobId: randomUUID(),
    speakerLabel: "speaker_1",
  }));
  const app = createApp(services(testConfig("http://localhost:1"), env.db));
  const res = await app.request("/naming-queue/answer", {
    body: JSON.stringify({
      answer: { kind: "confirm", name: "Nina" },
      voices: [...(card?.voices ?? []), ...strangers],
    }),
    headers: {
      Authorization: `Bearer ${OWNER_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  expect(res.status).toBe(200);
  expect((await res.json()).personId).toBeString();
});

test("a card about a known person carries no name that is already theirs", () => {
  const me = owner();
  const [marie] = env.db
    .insert(people)
    .values({ aliases: ["Jojo"], name: "Marie-Jo" })
    .returning()
    .all();
  conversation(me, talk(8), [identity({ name: "jojo", personId: marie?.id })]);
  conversation(me, talk(7), [identity({ name: "Sam", personId: marie?.id })]);
  expect(queued().map((c) => [c.kind, c.personId, c.name])).toEqual([
    ["known_person", marie?.id ?? null, null],
    ["known_person", marie?.id ?? null, "Sam"],
  ]);
});

test("the queue holds a voice once across days, and loses it once answered", () => {
  const me = owner();
  const day = 86_400_000;
  const first = conversation(me, talk(4), [identity({ name: "Hervé" })]);
  const second = conversation(me, talk(4), [], [], NOON + day);
  const old = conversation(me, talk(4), [], [], NOON - 40 * day);
  const group = randomUUID();
  env.db
    .insert(speakerAssignments)
    .values(
      [first, second, old].map(({ jobId }) => ({
        candidateId: group,
        jobId,
        source: "recognized" as const,
        speakerLabel: "speaker_1",
        status: "candidate" as const,
      }))
    )
    .run();
  // No conversation alone has enough back-and-forth for a card; together they do.
  const [item, ...rest] = queueCache(env.db).items();
  expect(rest).toEqual([]);
  expect(item).toMatchObject({
    conversations: 3,
    id: group,
    kind: "new_person",
    name: "Hervé",
  });
  expect(item?.voices.map((v) => v.jobId).sort()).toEqual(
    [first.jobId, second.jobId, old.jobId].sort()
  );

  answerVoices(env.db, item?.voices ?? [], {
    kind: "confirm",
    name: "Hervé",
  });
  expect(queueCache(env.db).items()).toEqual([]);
});

test("a voice that sounds like a stranger is never asked about", () => {
  const me = owner();
  const { jobId } = conversation(me, talk(8), [identity({ name: "Hervé" })]);
  env.db
    .insert(speakerAssignments)
    .values({
      jobId,
      source: "recognized",
      speakerLabel: "speaker_1",
      status: "stranger",
    })
    .run();
  expect(queued()).toEqual([]);
});

test("a card no summary named, that sounds like someone, asks about them", () => {
  const me = owner();
  const voice = Array.from({ length: 192 }, (_, i) => (i === 7 ? 1 : 0));
  const sample = (
    jobId: string,
    conversationId: string,
    turnIndex: number
  ) => ({
    conversationId,
    durationSeconds: 9,
    embedding: voice,
    jobId,
    modelId: "test/ecapa",
    modelRevision: "r1",
    speakerLabel: `speaker_${turnIndex % 2}`,
    turnIndex,
  });
  // The owner's voice profile, from another conversation.
  const earlier = conversation(me, talk(2));
  const evidence = env.db
    .insert(voiceSamples)
    .values([0, 2].map((i) => sample(earlier.jobId, earlier.id, i)))
    .returning()
    .all();
  env.db
    .insert(voiceProfiles)
    .values(
      evidence.map((e) => ({
        addedBy: "owner_confirmed" as const,
        personId: me,
        sampleId: e.id,
      }))
    )
    .run();
  // The owner, split off under another label: it "talks with" him.
  const split = conversation(me, talk(8));
  env.db
    .insert(voiceSamples)
    .values([1, 3].map((i) => sample(split.jobId, split.id, i)))
    .run();

  expect(queued()).toMatchObject([
    { kind: "known_person", name: null, personId: me },
  ]);
});

test("a card plays clean turns that sound like its voice, never one that is someone else first", () => {
  const me = owner();
  const talked = conversation(me, talk(8), [
    identity({ evidenceTurnIds: [3], name: "Hervé" }),
  ]);
  const axis = (k: number) =>
    Array.from({ length: 192 }, (_, i) => (i === k ? 1 : 0));
  // Turns 1 and 3 are Hervé (3 a long one, capped at 30 s); turn 5 is mostly someone else.
  env.db
    .insert(voiceSamples)
    .values(
      [
        [1, 9, axis(7)],
        [3, 30, axis(7)],
        [5, 9, axis(8)],
      ].map(([turnIndex, durationSeconds, embedding]) => ({
        conversationId: talked.id,
        durationSeconds: durationSeconds as number,
        embedding: embedding as number[],
        jobId: talked.jobId,
        modelId: "test/ecapa",
        modelRevision: "r1",
        speakerLabel: "speaker_1",
        turnIndex: turnIndex as number,
      }))
    )
    .run();
  const [card] = queued();
  const clips = card ? cardClips(env.db)(card) : [];
  expect(clips.map((c) => c.text)).toEqual(["turn 1", "turn 3", "turn 5"]);
  // Each clip is its turn, to name in place, with its words as they light up.
  expect(clips[0]).toMatchObject({
    at: new Date(NOON + 10_000).toISOString(),
    conversationId: talked.id,
    jobId: talked.jobId,
    personId: null,
    speakerLabel: "speaker_1",
    turnIndex: 1,
    words: [[0, 9000, 6]],
  });
  expect(Date.parse(clips[0]?.until ?? "")).toBeGreaterThan(NOON + 18_000);
  // A job from before the bucket has no audio of its own: the phone plays it from its recording.
  expect(clips.map((c) => c.audio)).toEqual([null, null, null]);

  // A job with bucket audio places each clip in it, cut at the clip's length.
  env.db
    .update(transcriptionJobs)
    .set({ objectKey: "blocks/test/a.ogg" })
    .where(is(transcriptionJobs.id, talked.jobId))
    .run();
  const inBucket = card ? cardClips(env.db)(card) : [];
  expect(inBucket.map((c) => c.audio)).toEqual([
    { end: 19, jobId: talked.jobId, start: 10 },
    { end: 39, jobId: talked.jobId, start: 30 },
    { end: 59, jobId: talked.jobId, start: 50 },
  ]);
});

test("every card has a clip: a sample of its voice, else its own longest turns", () => {
  const me = owner();
  const chatty = conversation(me, talk(10));
  const heard = conversation(me, talk(8), [], [], NOON + 3_600_000);
  env.db
    .insert(voiceSamples)
    .values({
      conversationId: heard.id,
      durationSeconds: 9,
      embedding: Array.from({ length: 192 }, (_, i) => (i === 7 ? 1 : 0)),
      jobId: heard.jobId,
      modelId: "test/ecapa",
      modelRevision: "r1",
      speakerLabel: "speaker_1",
      turnIndex: 1,
    })
    .run();
  const clips = Object.fromEntries(queued().map((c) => [c.id, c.clips.length]));
  expect(clips).toEqual({
    [`${chatty.jobId}/speaker_1`]: 3,
    [`${heard.jobId}/speaker_1`]: 1,
  });
});

// Oct 15, the owner's phone: every clip played 20 s of a one-word turn. The provider stretched a
// word over the cut-out silence after its interval; the clip is its words, and the voice's turns
// with the most words come first.
test("a clip stops with its last word; a voice without samples plays its wordiest turns", () => {
  const me = owner();
  const start = NOON;
  const talked = conversation(me, talk(10), [], [], start);
  const [row] = env.db
    .select({ parsed: transcripts.parsed })
    .from(transcripts)
    .where(is(transcripts.jobId, talked.jobId))
    .all();
  const parsed = row?.parsed;
  if (!parsed) {
    throw new Error("no transcript");
  }
  const said = (speakerId: string, ...timed: [string, number, number][]) =>
    timed.map(([text, from, to], i) => ({
      end: to,
      logprob: null,
      spacing: i === 0 ? "" : " ",
      speakerId,
      start: from,
      text,
    }));
  const words = parsed.words.filter((w) => w.start !== 10 && w.start !== 30);
  words.push(
    // Turn 1: "turn" at 10 s, then "1" stretched into the next interval, 45 s later in capture time.
    ...said("speaker_1", ["turn", 10, 11], ["1", 11, 19]),
    // Turn 3: three words.
    ...said("speaker_1", ["turn", 30, 33], ["3", 33, 36], ["now", 36, 39])
  );
  env.db
    .update(transcripts)
    .set({
      parsed: { ...parsed, words: words.sort((a, b) => a.start - b.start) },
    })
    .where(is(transcripts.jobId, talked.jobId))
    .run();
  // 15 s kept, a separator, then from 60 s on.
  mapJob(env.db, talked.jobId, [
    [start, start + 15_000],
    [start + 60_000, start + 260_000],
  ]);
  const [card] = queued();
  const clips = card ? cardClips(env.db)(card) : [];
  expect(clips.slice(0, 2).map((c) => [c.turnIndex, c.text])).toEqual([
    [3, "turn 3 now"],
    [1, "turn 1"],
  ]);
  expect(clips[1]).toMatchObject({
    at: new Date(start + 10_000).toISOString(),
    until: new Date(start + 15_000).toISOString(),
    words: [
      [0, 1000, 4],
      [1000, 5000, 2],
    ],
  });
});

// Oct 15: a turn went on after a cut-out silence. Its words after the cut were timed in capture time,
// 5 s on, while the bucket audio, with the silence cut out, played them 0.4 s on: the lit word fell
// behind what was heard. A clip from the bucket stops where its stretch of kept speech does.
test("a clip from the bucket audio stays in one stretch of kept speech", () => {
  const me = owner();
  const start = NOON;
  const talked = conversation(me, talk(10), [], [], start);
  const [row] = env.db
    .select({ parsed: transcripts.parsed })
    .from(transcripts)
    .where(is(transcripts.jobId, talked.jobId))
    .all();
  const parsed = row?.parsed;
  if (!parsed) {
    throw new Error("no transcript");
  }
  const word = (text: string, from: number, to: number) => ({
    end: to,
    logprob: null,
    spacing: " ",
    speakerId: "speaker_1",
    start: from,
    text,
  });
  // Turn 1, 10 s to 19 s into the file: two words before the cut at 15 s, one after its separator.
  const words = [
    ...parsed.words.filter((w) => w.start !== 10),
    word("turn", 10, 11),
    word("one", 12, 13),
    word("more", 17, 18),
  ].sort((a, b) => a.start - b.start);
  env.db
    .update(transcripts)
    .set({ parsed: { ...parsed, words } })
    .where(is(transcripts.jobId, talked.jobId))
    .run();
  env.db
    .update(transcriptionJobs)
    .set({ objectKey: "blocks/test/a.ogg" })
    .where(is(transcriptionJobs.id, talked.jobId))
    .run();
  // 15 s kept, then from 20 s on: 5 s cut out, 0.4 s of separator in the file.
  mapJob(env.db, talked.jobId, [
    [start, start + 15_000],
    [start + 20_000, start + 220_000],
  ]);
  const clips = cardClips(env.db)({
    kind: "new_person",
    personId: null,
    voices: [
      {
        conversationId: talked.id,
        jobId: talked.jobId,
        speakerLabel: "speaker_1",
      },
    ],
  });
  const clip = clips.find((c) => c.turnIndex === 1);
  expect(clip).toMatchObject({
    at: new Date(start + 10_000).toISOString(),
    audio: { end: 13, jobId: talked.jobId, start: 10 },
    until: new Date(start + 13_000).toISOString(),
    words: [
      [0, 1000, 4],
      [2000, 3000, 4],
    ],
  });
});

test("a clip from joined audio plays where the map's `starts` puts its stretch", () => {
  const me = owner();
  const start = NOON;
  const talked = conversation(me, talk(10), [], [], start);
  env.db
    .update(transcriptionJobs)
    .set({ objectKey: "blocks/test/a.ogg" })
    .where(is(transcriptionJobs.id, talked.jobId))
    .run();
  // Two fragments joined (audio.ts): the second stretch begins 26.5 ms past the uniform 15.4 s.
  mapJob(
    env.db,
    talked.jobId,
    [
      [start, start + 15_000],
      [start + 20_000, start + 220_000],
    ],
    400,
    [0, 15_426.5]
  );
  const clips = cardClips(env.db)({
    kind: "new_person",
    personId: null,
    voices: [
      {
        conversationId: talked.id,
        jobId: talked.jobId,
        speakerLabel: "speaker_1",
      },
    ],
  });
  // Turn 3 is 30 s to 39 s into the file, 14.5735 s into the second stretch: the clip says so in
  // capture time, and plays that stretch of the file within the half millisecond it is rounded to.
  const clip = clips.find((c) => c.turnIndex === 3);
  expect(clip?.until).toBe(new Date(start + 43_574).toISOString());
  expect(clip?.audio?.start).toBeCloseTo(30, 2);
  expect(clip?.audio?.end).toBeCloseTo(39, 2);
});

// Oct 15: "several people" names its passages in place, one turn at a time, then says who is in the
// voice: people.ts decides each other turn among them.
test("several people: passages named in place, then who; the one to fall back on", () => {
  const me = owner();
  const talked = conversation(me, talk(8), [identity({ name: "Hervé" })]);
  const voices = queued()[0]?.voices ?? [];
  const herve = randomUUID();
  assign(env.db, {
    jobId: talked.jobId,
    speakerLabel: "speaker_1",
    target: { id: herve, kind: "new", name: "Hervé" },
    turnIndex: 1,
  });
  // A passage named in place leaves the voice in the queue.
  expect(queued()).toHaveLength(1);
  const answer = () =>
    answerVoices(env.db, voices, {
      kind: "several",
      people: [me, herve],
      unknown: false,
    });
  expect(answer()).toEqual({ personId: null });
  answer();
  const rows = env.db.query.speakerAssignments
    .findMany({
      // The passage's row first (nulls sort last descending).
      orderBy: (a, { desc }) => desc(a.turnIndex),
      where: (a, { and, eq }) =>
        and(eq(a.jobId, talked.jobId), eq(a.speakerLabel, "speaker_1")),
    })
    .sync();
  // Hervé is the one besides the owner: the voice falls back on him; the passage stays his.
  expect(rows).toMatchObject([
    { personId: herve, source: "owner", turnIndex: 1 },
    {
      candidates: { people: [me, herve].sort(), unknown: false },
      personId: herve,
      source: "owner",
      turnIndex: null,
    },
  ]);
  expect(queued()).toEqual([]);
});

test("a voice marked several people before the multi-select comes back on its own until answered", async () => {
  const me = owner();
  const talked = conversation(me, ["speaker_0", "speaker_1"]);
  env.db
    .insert(speakerAssignments)
    .values({
      jobId: talked.jobId,
      mixed: true,
      personId: me,
      source: "recognized",
      speakerLabel: "speaker_1",
      status: "person",
    })
    .run();
  // Recognition leaves it as it is.
  await sweep(env.db);
  const [card, ...rest] = queued();
  expect(rest).toEqual([]);
  expect(card).toMatchObject({
    conversations: 1,
    id: `${talked.jobId}/speaker_1`,
    kind: "several",
    personId: null,
    seconds: 9,
    voices: [
      {
        conversationId: talked.id,
        jobId: talked.jobId,
        speakerLabel: "speaker_1",
      },
    ],
  });
  expect(card?.clips).toHaveLength(1);
  answerVoices(env.db, card?.voices ?? [], {
    kind: "several",
    people: [me],
    unknown: true,
  });
  expect(queued()).toEqual([]);
});
