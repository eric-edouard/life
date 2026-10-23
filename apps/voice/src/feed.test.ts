import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chapters,
  conversations,
  intelligenceRuns,
  ownerEdits,
  type Turn,
} from "@life/voice-db/schema";
import { sql } from "drizzle-orm";
import { createApp } from "./app";
import { latestSeq, logChange } from "./change-log";
import { sha256Hex } from "./config";
import { feed } from "./feed";
import { storeHistory } from "./location";
import { assign } from "./people";
import { addQuietRange } from "./quiet-ranges";
import { services } from "./services";
import { writeChapters } from "./summaries";
import { PROMPT_VERSION } from "./summary-calls";
import {
  OWNER_TOKEN,
  seedConversation,
  storedResult,
  testConfig,
  testDb,
} from "./testing";

let env: Awaited<ReturnType<typeof testDb>>;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  env = testDb();
  app = createApp(
    services(testConfig("http://localhost:1"), env.db, {
      intelligence: null,
      search: null,
    })
  );
});
afterAll(() => {
  env.drop();
});
beforeEach(() => {
  env.reset();
});

const start = Date.parse("2026-10-01T02:00:00Z");
const said: Turn[] = [
  { end: 4, speakerId: "speaker_0", start: 0, text: "Remember the plumber." },
  { end: 9, speakerId: "speaker_1", start: 5, text: "Monday at nine." },
];

// A conversation of one transcribed job, its turns built (turns.ts) and logged.
function conversation(at = start) {
  const seeded = seedConversation(env.db, said, { at, ms: 60_000 });
  env.db.transaction((tx) => logChange(tx, "conversation", seeded.id));
  return seeded;
}

const get = async (query: string) => {
  const res = await app.request(`/changes?${query}`, {
    headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Awaited<ReturnType<typeof feed>> & {
    mac: unknown;
  };
};

// A second connection in a worker, writing through `logChange`: each transaction holds the write
// lock a random while after its insert (seq taken) before committing, while this thread's own
// writes queue behind it and the reader pages. A seq handed out before commit order would let the
// reader pass a change it hadn't seen yet.
const WRITER = `
  import { connect } from ${JSON.stringify(Bun.resolveSync("@life/voice-db", import.meta.dir))};
  import { logChange } from ${JSON.stringify(`${import.meta.dir}/change-log.ts`)};
  self.onmessage = async ({ data: { file, ids } }) => {
    const db = connect(file);
    for (const id of ids) {
      db.transaction((tx) => {
        logChange(tx, "person", id);
        Bun.sleepSync(Math.random() * 20);
      });
      await Bun.sleep(Math.random() * 5);
    }
    db.$client.close(true);
    postMessage("done");
  };`;

test("a reader paging during concurrent writes never skips a seq", async () => {
  const ids = Array.from({ length: 60 }, () => randomUUID());
  const worker = new Worker(
    URL.createObjectURL(new Blob([WRITER], { type: "text/javascript" }))
  );
  const theirs = new Promise((resolve) => {
    worker.onmessage = resolve;
  });
  worker.postMessage({ file: env.db.$client.filename, ids: ids.slice(0, 30) });
  const ours = Promise.all(
    ids.slice(30).map(async (id) => {
      await Bun.sleep(Math.random() * 300);
      env.db.transaction((tx) => logChange(tx, "person", id));
    })
  );
  let finished = false;
  Promise.all([theirs, ours]).then(() => {
    finished = true;
  });
  const seen = new Set<string>();
  let cursor = 0;
  for (;;) {
    const settled = finished;
    const page = feed(env.db, cursor, null, 3);
    expect(Number(page.cursor)).toBeGreaterThanOrEqual(cursor);
    for (const r of page.removed) {
      expect(seen.has(r.ref)).toBe(false);
      seen.add(r.ref);
    }
    // Every write had committed before this read, and it found nothing new: all read.
    if (settled && Number(page.cursor) === cursor) {
      break;
    }
    cursor = Number(page.cursor);
    // biome-ignore lint/performance/noAwaitInLoops: a reader polls in order
    await Bun.sleep(1);
  }
  worker.terminate();
  // People that don't exist come as removed: every write was read, once.
  expect([...seen].sort()).toEqual([...ids].sort());
  expect(cursor).toBe(latestSeq(env.db));
});

test("turns come with their conversation, and again with a newer seq when revised", () => {
  const { id, jobId } = conversation();
  const first = feed(env.db, 0);
  expect(first.conversations.map((c) => c.id)).toEqual([id]);
  expect(first.conversations[0]).toMatchObject({
    kind: "conversation",
    retired: null,
    startAt: new Date(start).toISOString(),
    state: "transcribed",
  });
  expect(
    first.turns.map((t) => [t.turnIndex, t.text, t.conversationId])
  ).toEqual([
    [0, "Remember the plumber.", id],
    [1, "Monday at nine.", id],
  ]);
  expect(first.turns[0]?.speaker).toEqual({
    displayName: "Speaker 1",
    isOwner: false,
    label: "speaker_0",
    personId: null,
    personName: null,
  });

  const named = assign(env.db, {
    jobId,
    speakerLabel: "speaker_1",
    target: { id: randomUUID(), kind: "new", name: "Marie-Jo" },
    turnIndex: null,
  });
  expect(Array.isArray(named)).toBe(true);
  const next = feed(env.db, Number(first.cursor));
  expect(Number(next.cursor)).toBeGreaterThan(Number(first.cursor));
  const revised = next.turns.find((t) => t.turnIndex === 1);
  expect(revised?.jobId).toBe(jobId);
  expect(revised?.speaker.personName).toBe("Marie-Jo");
  expect(next.people.map((p) => p.name)).toEqual(["Marie-Jo"]);
});

test("dictation and media are hidden in the turns' text", () => {
  const { jobId } = conversation();
  // The owner dictated over the second turn (seconds 5 to 9).
  addQuietRange(env.db, {
    endedAt: new Date(start + 10_000).toISOString(),
    id: randomUUID(),
    source: "com.apple.dictation",
    startedAt: new Date(start + 4500).toISOString(),
  });
  assign(env.db, {
    jobId,
    speakerLabel: "speaker_0",
    target: { kind: "media" },
    turnIndex: null,
  });
  const page = feed(env.db, 0);
  expect(page.turns.map((t) => t.text)).toEqual(["", ""]);
  expect(page.quietRanges).toHaveLength(1);
});

test("each turn's words come timed, as its text shows them", () => {
  const word = (text: string, from: number, to: number, spacing = " ") => ({
    end: to,
    logprob: null,
    spacing,
    speakerId: "speaker_0",
    start: from,
    text,
  });
  seedConversation(env.db, said.slice(0, 1), {
    at: start,
    words: [
      word("Remember", 0, 0.8, ""),
      word("the", 0.9, 1.1),
      word("plumber.", 1.2, 2),
    ],
  });
  // The owner dictated over "the".
  addQuietRange(env.db, {
    endedAt: new Date(start + 1150).toISOString(),
    id: randomUUID(),
    source: "com.apple.dictation",
    startedAt: new Date(start + 850).toISOString(),
  });
  const [turn] = feed(env.db, 0).turns;
  expect(turn?.text).toBe("Remember plumber.");
  expect(turn?.words).toEqual([
    [0, 800, 8],
    [1200, 2000, 9],
  ]);
});

test("a retired conversation comes with its successor", () => {
  const kept = conversation();
  const gone = randomUUID();
  const before = latestSeq(env.db);
  env.db.transaction((tx) => {
    tx.insert(conversations)
      .values({
        captureEndedAt: new Date(start - 60_000),
        captureStartedAt: new Date(start - 120_000),
        id: gone,
        retiredAt: new Date(),
        successorId: kept.id,
      })
      .run();
    logChange(tx, "conversation", gone);
  });
  const page = feed(env.db, before);
  expect(page.conversations).toEqual([
    expect.objectContaining({ id: gone, retired: { successorId: kept.id } }),
  ]);
});

test("a conversation says when grouping is done with it, and a job whether it closed on silence", () => {
  // One no source groups (from before sources) is settled from the start.
  const legacy = conversation();
  expect(feed(env.db, 0).conversations).toEqual([
    expect.objectContaining({ closed: true, id: legacy.id }),
  ]);
  env.reset();
  // Grouped from a source: open until grouping closes it (one without a source is settled).
  const seeded = conversation();
  env.db
    .update(conversations)
    .set({ sourceId: "dev1" })
    .where(sql`${conversations.id} = ${seeded.id}`)
    .run();
  env.db.transaction((tx) => logChange(tx, "job", seeded.jobId));
  const open = feed(env.db, 0);
  expect(open.conversations).toEqual([
    expect.objectContaining({ closed: false, id: seeded.id }),
  ]);
  expect(open.jobs.map((j) => j.endedOnSilence)).toEqual([null]);
  const before = latestSeq(env.db);
  env.db.transaction((tx) => {
    tx.update(conversations)
      .set({ closedAt: new Date() })
      .where(sql`${conversations.id} = ${seeded.id}`)
      .run();
    logChange(tx, "conversation", seeded.id);
  });
  expect(feed(env.db, before).conversations).toEqual([
    expect.objectContaining({ closed: true, id: seeded.id }),
  ]);
});

test("a reader's token opens the contract's reads, and corrections only with that scope", async () => {
  const [read, correct] = ["read-test-token", "corrections-test-token"];
  const scoped = createApp(
    services(
      testConfig("http://localhost:1", {
        CORRECTIONS_TOKEN_HASH: sha256Hex(correct),
        READ_TOKEN_HASH: sha256Hex(read),
      }),
      env.db,
      { intelligence: null, search: null }
    )
  );
  const status = async (token: string, path: string, method = "GET") =>
    (
      await scoped.request(path, {
        body: method === "GET" ? null : "{}",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        method,
      })
    ).status;
  const person = `/people/${randomUUID()}`;
  for (const token of [read, correct, OWNER_TOKEN]) {
    // biome-ignore lint/performance/noAwaitInLoops: one request at a time
    expect(await status(token, "/changes")).toBe(200);
    expect(await status(token, "/capabilities")).toBe(200);
  }
  // A read token neither corrects nor reaches the phone's routes; corrections reach only theirs.
  expect(await status(read, person, "PATCH")).toBe(403);
  expect(await status(correct, person, "PATCH")).not.toBe(403);
  expect(await status(correct, "/switches")).toBe(403);
  expect(await status(OWNER_TOKEN, "/switches")).toBe(200);
  expect(await status("nobody", "/changes")).toBe(401);
});

test("a cursor past the archive starts over instead of skipping", async () => {
  addQuietRange(env.db, {
    endedAt: new Date(start + 1000).toISOString(),
    id: randomUUID(),
    source: "com.apple.dictation",
    startedAt: new Date(start).toISOString(),
  });
  const ahead = await get(`since=${latestSeq(env.db) + 100}`);
  expect(ahead.quietRanges.length).toBeGreaterThan(0);
  expect(Number(ahead.cursor)).toBeLessThanOrEqual(latestSeq(env.db));
});

test("a long poll answers as soon as something is written, and empty at its timeout", async () => {
  const since = latestSeq(env.db);
  const asked = Date.now();
  const answer = get(`since=${since}&wait=10`);
  await Bun.sleep(300);
  addQuietRange(env.db, {
    endedAt: new Date(start + 1000).toISOString(),
    id: randomUUID(),
    source: "com.apple.dictation",
    startedAt: new Date(start).toISOString(),
  });
  const page = await answer;
  expect(Date.now() - asked).toBeLessThan(3000);
  expect(page.quietRanges).toHaveLength(1);
  expect(Number(page.cursor)).toBeGreaterThan(since);

  const idle = Date.now();
  const empty = await get(`since=${page.cursor}&wait=1`);
  expect(Date.now() - idle).toBeGreaterThanOrEqual(1000);
  expect(empty.cursor).toBe(page.cursor);
  expect(empty.turns).toEqual([]);
  expect(empty.more).toBe(false);
});

test("a conversation carries its place and its unsure splits, minus the dismissed ones", () => {
  const { id, jobId } = conversation();
  const capturedAt = (turnIndex: number) =>
    new Date(start + turnIndex * 5000).toISOString();
  const result = storedResult(0, 1);
  env.db
    .insert(intelligenceRuns)
    .values({
      conversationId: id,
      model: "claude-sonnet-5-5",
      promptVersion: PROMPT_VERSION,
      provider: "claude-code",
      result: {
        ...result,
        boundarySuggestions: [
          {
            confidence: "medium",
            evidenceTurnIds: [1],
            kind: "split_at_turn",
            reason: "call",
            turnId: 1,
          },
          {
            confidence: "high",
            evidenceTurnIds: [1],
            kind: "split_at_turn",
            reason: "bye",
            turnId: 1,
          },
        ],
      },
      state: "valid",
      turns: [0, 1].map((turnIndex) => ({
        capturedAt: capturedAt(turnIndex),
        jobId,
        turnIndex,
      })),
    })
    .run();
  // Named fixes around it: the most accurate names it, and the feed hears of it.
  const before = latestSeq(env.db);
  storeHistory(env.db, {
    fixes: [
      {
        accuracyM: 40,
        latitude: 21.0,
        longitude: 105.8,
        observedAt: new Date(start - 60_000).toISOString(),
        placeName: "Oakridge 31",
      },
      {
        accuracyM: 8,
        latitude: 21.0,
        longitude: 105.8,
        observedAt: new Date(start + 30_000).toISOString(),
        placeName: "Bakery, Oakridge 31",
      },
    ],
    visits: [],
  });
  const page = feed(env.db, before);
  expect(page.conversations).toEqual([
    expect.objectContaining({
      id,
      place: "Bakery, Oakridge 31",
      splitSuggestions: [{ at: capturedAt(1), confidence: "medium" }],
    }),
  ]);
  env.db
    .insert(ownerEdits)
    .values({
      at: new Date(capturedAt(1)),
      editedAt: new Date(),
      id: randomUUID(),
      kind: "dismissSplit",
    })
    .run();
  expect(feed(env.db, 0).conversations[0]?.splitSuggestions).toEqual([]);
});

test("chapters come from the latest valid run, with stable ids", () => {
  const { id, jobId } = conversation();
  env.db
    .insert(intelligenceRuns)
    .values({
      conversationId: id,
      model: "claude-sonnet-5-5",
      promptVersion: PROMPT_VERSION,
      provider: "claude-code",
      result: storedResult(0, 1),
      state: "valid",
      turns: [0, 1].map((turnIndex) => ({
        capturedAt: new Date(start + turnIndex * 5000).toISOString(),
        jobId,
        turnIndex,
      })),
    })
    .run();
  writeChapters(env.db, id);
  const page = feed(env.db, 0);
  expect(page.conversations[0]?.title).toBe("Turns 0-1");
  expect(page.conversations[0]?.tldr).toBe("They talked.");
  expect(page.chapters).toEqual([
    expect.objectContaining({
      conversationId: id,
      endAt: new Date(start + 60_000).toISOString(),
      startAt: new Date(start).toISOString(),
      title: "All of it",
    }),
  ]);
  const [before] = env.db.select().from(chapters).all();
  writeChapters(env.db, id);
  const [after] = env.db.select().from(chapters).all();
  expect(after?.id).toBe(before?.id);
});
