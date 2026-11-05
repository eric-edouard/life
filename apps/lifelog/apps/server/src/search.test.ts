import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  EMBEDDER_DIMENSIONS,
  EMBEDDER_MODEL,
  type Embedder,
} from "@life/server/src/core/embedder";
import {
  conversations,
  people,
  speakerAssignments,
  type Turn,
} from "@lifelog/db/schema";
import { createApp } from "./app";
import { addQuietRange } from "./quiet-ranges";
import { cutPassages, searchFor } from "./search";
import { services } from "./services";
import { setSwitches } from "./switches";
import {
  mapJob,
  OWNER_TOKEN,
  seedTranscript,
  testConfig,
  testDb,
} from "./testing";
import type { LoadedTurn } from "./transcript";

let env: Awaited<ReturnType<typeof testDb>>;

beforeAll(() => {
  env = testDb();
});
afterAll(() => {
  env.drop();
});
beforeEach(() => {
  env.reset();
  seeded = 0;
});

// Conversations seeded in this test: each starts two hours after the one before (their words
// never overlap).
let seeded = 0;

const auth = {
  Authorization: `Bearer ${OWNER_TOKEN}`,
  "Content-Type": "application/json",
};

// A unit vector along one axis.
const axis = (i: number) =>
  Array.from({ length: EMBEDDER_DIMENSIONS }, (_, k) => (k === i ? 1 : 0));

// Words hashed into dimensions, so texts sharing words point the same way. `fixed` pins
// the vector of an exact text. Every input it embeds is recorded.
function fakeEmbedder(fixed: Record<string, number[]> = {}) {
  const inputs: string[] = [];
  const bagOfWords = (text: string) => {
    const v = new Array<number>(EMBEDDER_DIMENSIONS).fill(0);
    for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
      const h = [...word].reduce(
        (a, ch) => (a * 31 + ch.charCodeAt(0)) % 1_000_003,
        7
      );
      v[h % EMBEDDER_DIMENSIONS] = (v[h % EMBEDDER_DIMENSIONS] ?? 0) + 1;
    }
    v[EMBEDDER_DIMENSIONS - 1] = 0.01; // never the zero vector
    return v;
  };
  const embedder: Embedder & { inputs: string[] } = {
    embed: (texts) => {
      inputs.push(...texts);
      return Promise.resolve(texts.map((t) => fixed[t] ?? bagOfWords(t)));
    },
    inputs,
    model: EMBEDDER_MODEL,
  };
  return embedder;
}

function setup(embedder = fakeEmbedder()) {
  const search = searchFor(env.db, testConfig("http://localhost:1"), embedder);
  if (!search) {
    throw new Error("no search");
  }
  const app = createApp(
    services(testConfig("http://localhost:1"), env.db, {
      intelligence: null,
      search,
    })
  );
  return { app, embedder, search };
}

// Ten-second turns with these texts and speakers.
const turns = (
  texts: string[],
  speaker = (i: number) => `speaker_${i % 2}`
): Turn[] =>
  texts.map((text, i) => ({
    end: i * 10 + 9,
    speakerId: speaker(i),
    start: i * 10,
    text,
  }));

// A conversation registered with a time map starting at `start`; returns its ids.
function conversation(
  _app: ReturnType<typeof setup>["app"],
  texts: string[],
  start = new Date(
    Date.parse("2026-10-01T09:00:00Z") + seeded * 7_200_000
  ).toISOString(),
  speaker?: (i: number) => string
) {
  seeded += 1;
  const id = randomUUID();
  const jobId = seedTranscript(env.db, turns(texts, speaker));
  const at = Date.parse(start);
  env.db
    .insert(conversations)
    .values({
      captureEndedAt: new Date(at + 3_600_000),
      captureStartedAt: new Date(at),
      id,
    })
    .run();
  mapJob(env.db, jobId, [[at, at + 3_600_000]]);
  return { id, jobId };
}

const find = async (
  app: ReturnType<typeof setup>["app"],
  body: Record<string, unknown>
) => {
  const res = await app.request("/search", {
    body: JSON.stringify(body),
    headers: auth,
    method: "POST",
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { hits: Record<string, unknown>[] }).hits;
};

test("turns become passages of 30 to 60 s that never span parts", () => {
  const turn = (jobId: string, i: number, seconds = 10): LoadedTurn => ({
    endedAt: null,
    endSeconds: i * 10 + seconds,
    languageCode: "eng",
    person: i === 0 ? { id: randomUUID(), name: "Ploy" } : null,
    ref: { capturedAt: null, jobId, turnIndex: i },
    speaker: "speaker_0",
    speakerLabel: "speaker_0",
    startSeconds: i * 10,
    text: `turn ${i}`,
    words: [],
  });
  const a = Array.from({ length: 7 }, (_, i) => turn("a", i));
  const passages = cutPassages([...a, turn("b", 0), turn("b", 1, 100)]);
  expect(passages.map((p) => [p.jobId, p.firstTurn, p.lastTurn])).toEqual([
    ["a", 0, 2],
    ["a", 3, 5],
    ["a", 6, 6],
    ["b", 0, 0], // a new part starts a passage
    ["b", 1, 1], // one long turn stays whole
  ]);
  expect(passages[0]?.text).toBe("Ploy: turn 0\nturn 1\nturn 2");
  expect(passages[0]?.speakers).toEqual(["Ploy"]);
});

test("indexing embeds each passage once, with capture times", async () => {
  const { app, embedder, search } = setup();
  const { id } = conversation(
    app,
    Array.from({ length: 9 }, (_, i) => `we talked about item ${i}`)
  );
  await search.index();
  expect(embedder.inputs).toHaveLength(3);
  const rows = env.db.query.searchPassages
    .findMany({
      orderBy: (p, { asc }) => asc(p.firstTurn),
    })
    .sync();
  expect(rows.map((r) => r.conversationId)).toEqual([id, id, id]);
  expect(rows[1]?.capturedFrom?.toISOString()).toBe("2026-10-01T09:00:40.000Z");
  expect(rows[1]?.capturedTo?.toISOString()).toBe("2026-10-01T09:01:19.000Z");

  // Nothing changed: no new request.
  await search.index();
  expect(embedder.inputs).toHaveLength(3);
});

test("naming a speaker re-embeds only the passages they speak in", async () => {
  const { app, embedder, search } = setup();
  // Two passages of four turns: speaker_0's, then speaker_1's.
  const { jobId } = conversation(
    app,
    Array.from({ length: 8 }, (_, i) => `line ${i}`),
    undefined,
    (i) => (i < 4 ? "speaker_0" : "speaker_1")
  );
  await search.index();
  expect(embedder.inputs).toHaveLength(2);

  const res = await app.request(`/transcripts/${jobId}/speakers/speaker_1`, {
    body: JSON.stringify({
      target: { id: randomUUID(), kind: "new", name: "Somchai" },
    }),
    headers: auth,
    method: "PUT",
  });
  expect(res.status).toBe(200);
  await search.index();
  expect(embedder.inputs.slice(2)).toEqual([
    "Somchai: line 4\nSomchai: line 5\nSomchai: line 6\nSomchai: line 7",
  ]);
  const named = env.db.query.searchPassages
    .findFirst({
      where: (p, { eq }) => eq(p.firstTurn, 4),
    })
    .sync();
  expect(named?.speakers).toEqual(["Somchai"]);
});

test("turns the owner marked as media are left out of passages", async () => {
  const { app, search } = setup();
  const { id, jobId } = conversation(app, [
    "we should leave at six",
    "breaking news tonight",
    "fine, six it is",
    "weather after the break",
  ]);
  await search.index();
  const res = await app.request(`/transcripts/${jobId}/speakers/speaker_1`, {
    body: JSON.stringify({ target: { kind: "media" } }),
    headers: auth,
    method: "PUT",
  });
  expect(res.status).toBe(200);
  await search.index();

  const passages = env.db.query.searchPassages
    .findMany({
      where: (p, { eq }) => eq(p.conversationId, id),
    })
    .sync();
  expect(passages.map((p) => p.text)).toEqual([
    "we should leave at six\nfine, six it is",
  ]);
});

test("a quiet range that arrives later takes its words out of passages", async () => {
  const { app, search } = setup();
  const { id } = conversation(app, [
    "we should leave at six",
    "reply to Anna about the invoice",
    "fine, six it is",
  ]);
  await search.index();
  const at = Date.parse("2026-10-01T09:00:00Z");
  addQuietRange(env.db, {
    endedAt: new Date(at + 20_000).toISOString(),
    id: randomUUID(),
    source: "com.FluidApp.app",
    startedAt: new Date(at + 10_000).toISOString(),
  });
  await search.index();

  const passages = env.db.query.searchPassages
    .findMany({
      where: (p, { eq }) => eq(p.conversationId, id),
    })
    .sync();
  expect(passages.map((p) => p.text)).toEqual([
    "we should leave at six\nfine, six it is",
  ]);
});

test("a passage both rankings find outranks one only meaning finds", async () => {
  const embedder = fakeEmbedder({
    Somchai: axis(2), // the query means the ferry passage most, the boat one a little
    "Somchai said the boat leaves at six": axis(1).map(
      (x, i) => x + (i === 2 ? 0.5 : 0)
    ),
    "the ferry departs early tomorrow": axis(2),
  });
  const { app, search } = setup(embedder);
  conversation(app, ["the ferry departs early tomorrow"]);
  conversation(app, ["Somchai said the boat leaves at six"]);
  await search.index();

  const hits = await find(app, { query: "Somchai" });
  expect(hits.map((h) => h.text)).toEqual([
    "Somchai said the boat leaves at six",
    "the ferry departs early tomorrow",
  ]);
  expect(hits[0]?.exact).toBe(true);
  expect(hits[1]?.exact).toBe(false);
});

test("meaning finds a passage that shares no exact phrase; noise is dropped", async () => {
  const { app, search } = setup();
  conversation(app, ["the budget for the new office is too high"]);
  conversation(app, ["completely unrelated chatter about football"]);
  await search.index();

  const hits = await find(app, { query: "office budget worries" });
  expect(hits.map((h) => h.text)).toEqual([
    "the budget for the new office is too high",
  ]);
  expect(hits[0]?.capturedFrom).toBe("2026-10-01T09:00:00.000Z");
});

test("the date range keeps passages captured inside it", async () => {
  const { app, search } = setup();
  const early = conversation(
    app,
    ["lunch plans at the market"],
    "2026-09-01T12:00:00Z"
  );
  const late = conversation(
    app,
    ["lunch plans at the market"],
    "2026-10-05T12:00:00Z"
  );
  await search.index();

  const all = await find(app, { query: "lunch plans" });
  expect(new Set(all.map((h) => h.conversationId))).toEqual(
    new Set([early.id, late.id])
  );
  const october = await find(app, {
    dateRange: { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" },
    query: "lunch plans",
  });
  expect(october.map((h) => h.conversationId)).toEqual([late.id]);
});

test("people keeps the passages one of them speaks in", async () => {
  const { app, search } = setup();
  const named = conversation(app, ["dinner with the neighbours on Friday"]);
  conversation(app, ["dinner with the neighbours on Friday"]);
  const person = env.db
    .insert(people)
    .values({ name: "Quill Testperson" })
    .returning()
    .get();
  env.db
    .insert(speakerAssignments)
    .values({
      jobId: named.jobId,
      personId: person?.id ?? null,
      source: "owner",
      speakerLabel: "speaker_0",
      status: "person",
    })
    .run();
  await search.index();
  const hits = await find(app, { people: [person?.id], query: "dinner" });
  expect(hits.map((h) => h.conversationId)).toEqual([named.id]);
});

test("search needs the owner's token and an embedder that answers, not summaries", async () => {
  const { app } = setup();
  setSwitches(env.db, { ai: false });
  expect(await find(app, { query: "anything" })).toEqual([]);
  const anonymous = await app.request("/search", {
    body: JSON.stringify({ query: "anything" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  expect(anonymous.status).toBe(401);

  const keyless = createApp(
    services(testConfig("http://localhost:1"), env.db, {
      intelligence: null,
      search: null,
    })
  );
  const res = await keyless.request("/search", {
    body: JSON.stringify({ query: "anything" }),
    headers: auth,
    method: "POST",
  });
  expect(res.status).toBe(503);

  const { app: down } = setup({
    ...fakeEmbedder(),
    embed: () => Promise.reject(new Error("connection refused")),
  });
  const unanswered = await down.request("/search", {
    body: JSON.stringify({ query: "anything" }),
    headers: auth,
    method: "POST",
  });
  expect(unanswered.status).toBe(503);
});
