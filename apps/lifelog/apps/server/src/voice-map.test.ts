import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { people, voiceProfiles, voiceSamples } from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { mintToken } from "../scripts/mint-token";
import { createApp } from "./app";
import { loadConfig, RECOGNITION, sha256Hex } from "./config";
import { queueCache } from "./naming-queue";
import { services } from "./services";
import { rankPeople } from "./speakers";
import { OWNER_TOKEN, seedTranscript, testConfig, testDb } from "./testing";
import { readVoiceMap } from "./voice-map";
import { pcaOf } from "./voice-pca";

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
const mapToken = mintToken("map");
const config = () =>
  testConfig("http://localhost:1", {
    CORRECTIONS_TOKEN_HASH: sha256Hex("corrector"),
    MAC_TOKEN_HASH: sha256Hex("helper"),
    MAP_TOKEN_HASH: mapToken.hash,
    READ_TOKEN_HASH: sha256Hex("reader"),
  });
const app = () => createApp(services(config(), env.db, { intelligence: null }));
const headers = (token = mapToken.token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

test("map token kind mints only its own hash and config validates it", () => {
  expect(mapToken.variable).toBe("MAP_TOKEN_HASH");
  expect(mapToken.hash).toBe(sha256Hex(mapToken.token));
  expect(mintToken("map").token).not.toBe(mapToken.token);
  expect(config().MAP_TOKEN_HASH).toBe(mapToken.hash);
  expect(() => loadConfig({ MAP_TOKEN_HASH: "bad" })).toThrow();
  expect(() => mintToken("not-a-kind")).toThrow();
  for (const kind of ["device", "mac", "read", "corrections"]) {
    expect(String(mintToken(kind).variable)).toBe(
      `${kind.toUpperCase()}_TOKEN_HASH`
    );
  }
});

test("map token opens exactly the map, existing clip audio and queue answer", async () => {
  const server = app();
  const status = async (path: string, method = "GET", token = mapToken.token) =>
    (
      await server.request(path, {
        body: method === "GET" ? null : "{}",
        headers: headers(token),
        method,
      })
    ).status;
  expect(await status("/speakers/map")).toBe(200);
  expect(await status(`/transcripts/${randomUUID()}/audio`)).toBe(404);
  expect(await status("/naming-queue/answer", "POST")).toBe(400);
  for (const [method, path] of [
    ["GET", "/changes"],
    ["GET", "/naming-queue"],
    ["GET", "/status"],
    ["GET", "/openapi.json"],
    ["GET", "/switches"],
    ["POST", "/search"],
    ["PUT", `/transcripts/${randomUUID()}/speakers/voice`],
    ["PATCH", `/people/${randomUUID()}`],
    ["POST", "/speakers/map"],
    ["POST", `/transcripts/${randomUUID()}/audio`],
    ["GET", "/naming-queue/answer"],
    ["GET", `/transcripts/${randomUUID()}/audio/extra`],
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: auth assertions are sequential
    expect(await status(path ?? "", method)).toBe(403);
  }
  for (const token of ["reader", "corrector"]) {
    // biome-ignore lint/performance/noAwaitInLoops: auth assertions are sequential
    expect(await status("/speakers/map", "GET", token)).toBe(403);
  }
  expect(await status("/speakers/map", "GET", "nobody")).toBe(401);
  expect(await status("/speakers/map", "GET", "helper")).toBe(401);
  expect((await server.request("/speakers/map")).status).toBe(401);
  expect(await status("/speakers/map", "GET", OWNER_TOKEN)).toBe(200);
});

test("static page and pinned assets are public and contain no archive data", async () => {
  env.db.insert(people).values({ name: "Private made-up name" }).run();
  const server = app();
  const page = await server.request("/voices");
  const html = await page.text();
  expect(page.status).toBe(200);
  expect(html).not.toContain("Private made-up name");
  expect(html).not.toContain("https://");
  expect(html).toContain("./plotly-4.0.0.min.js");
  expect(page.headers.get("Content-Security-Policy")).toContain(
    "connect-src 'self'"
  );
  expect((await server.request("/voices/page.js")).status).toBe(200);
  const plotly = await server.request("/voices/plotly-4.0.0.min.js");
  expect(plotly.status).toBe(200);
  expect((await plotly.text()).slice(0, 80)).toContain("plotly.js v4.0.0");
});

function seedMap() {
  const owner = randomUUID();
  const guest = randomUUID();
  env.db
    .insert(people)
    .values([
      { id: owner, isOwner: true, name: "Owner" },
      { id: guest, name: "Guest" },
    ])
    .run();
  const jobId = seedTranscript(env.db, [
    { end: 10, speakerId: "a", start: 0, text: "A made-up voice" },
    { end: 20, speakerId: "b", start: 10, text: "Another voice" },
    { end: 30, speakerId: "c", start: 20, text: "Words awaiting a name" },
    { end: 40, speakerId: "c", start: 30, text: "Another model" },
  ]);
  const conversationId = randomUUID();
  const samples = env.db
    .insert(voiceSamples)
    .values([
      {
        conversationId,
        durationSeconds: 10,
        embedding: [1, 0, 0],
        jobId,
        modelId: "first",
        modelRevision: "r1",
        speakerLabel: "a",
        turnIndex: 0,
      },
      {
        conversationId,
        durationSeconds: 10,
        embedding: [0, 1, 0],
        jobId,
        modelId: "first",
        modelRevision: "r1",
        speakerLabel: "b",
        turnIndex: 1,
      },
      {
        conversationId,
        durationSeconds: 10,
        embedding: [0.8, 0.6, 0],
        jobId,
        modelId: "first",
        modelRevision: "r1",
        speakerLabel: "c",
        turnIndex: 2,
      },
      {
        conversationId,
        durationSeconds: 10,
        embedding: [1, 0],
        jobId,
        modelId: "second",
        modelRevision: "r2",
        speakerLabel: "c",
        turnIndex: 3,
      },
    ])
    .returning()
    .all();
  env.db
    .insert(voiceProfiles)
    .values([
      { personId: owner, sampleId: samples[0]?.id ?? "" },
      { personId: guest, sampleId: samples[1]?.id ?? "" },
    ])
    .run();
  const card = {
    clips: [],
    conversations: 1,
    evidence: [],
    exchanges: 12,
    id: "group",
    kind: "new_person" as const,
    name: null,
    personId: null,
    seconds: 100,
    voices: [{ conversationId, jobId, speakerLabel: "c" }],
    words: 420,
  };
  return { cards: [card], guest, owner, sampleId: samples[2]?.id ?? "" };
}

test("map read keeps queue cards/order, ranks through speakers and separates models without writing or caching", async () => {
  const { owner, guest, cards, sampleId } = seedMap();
  const queue = { items: () => cards };
  const server = createApp(
    services(config(), env.db, { intelligence: null, queue })
  );
  const before = env.db.$client.serialize();
  const result = await (
    await server.request("/speakers/map", { headers: headers() })
  ).json();
  expect(result.cards).toEqual(cards);
  expect(result.candidateThreshold).toBe(RECOGNITION.candidateThreshold);
  expect(result.models.map((m: { model: string }) => m.model)).toEqual([
    "first@r1",
    "second@r2",
  ]);
  const point = result.models[0].points.find(
    (p: { id: string }) => p.id === "group"
  );
  expect(point.words).toBe(420);
  expect(point.ranking).toEqual(
    rankPeople(
      [0.8, 0.6, 0],
      [
        { exemplars: [[1, 0, 0]], isOwner: true, personId: owner },
        { exemplars: [[0, 1, 0]], isOwner: false, personId: guest },
      ]
    ).map(({ personId, score, margin }) => ({ margin, personId, score }))
  );
  expect(result.models[1].points[0].ranking).toEqual([]);
  expect(env.db.$client.serialize()).toEqual(before);
  env.db
    .update(voiceSamples)
    .set({ embedding: [0, 1, 0] })
    .where(eq(voiceSamples.id, sampleId))
    .run();
  expect(
    readVoiceMap(env.db, cards).models[0]?.points.find((p) => p.id === "group")
      ?.ranking[0]?.personId
  ).toBe(guest);
});

test("empty queue and archive read without writes", () => {
  const before = env.db.$client.serialize();
  const result = readVoiceMap(env.db, queueCache(env.db).items());
  expect(result).toEqual({
    candidateThreshold: RECOGNITION.candidateThreshold,
    cards: [],
    models: [],
    people: [],
  });
  expect(env.db.$client.serialize()).toEqual(before);
});

test("PCA centers, orders variance and preserves 3D distances including rotated and deficient sets", () => {
  expect(pcaOf([])).toEqual([]);
  expect(pcaOf([[2, 3, 4]])).toEqual([[0, 0, 0]]);
  const vectors = [
    [3, 1, 1],
    [-3, -1, 1],
    [0, 2, -1],
    [0, -2, -1],
  ];
  const points = pcaOf(vectors);
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const distance = (rows: number[][]) =>
        Math.hypot(...(rows[i] ?? []).map((x, k) => x - (rows[j]?.[k] ?? 0)));
      expect(distance(points)).toBeCloseTo(distance(vectors), 8);
    }
  }
  expect(points[0]?.[0]).not.toBe(0);
  expect(pcaOf([[1], [3]])).toEqual([
    [-1, 0, 0],
    [1, 0, 0],
  ]);
  const variances = [0, 1, 2].map((i) =>
    points.reduce((sum, p) => sum + (p[i] ?? 0) ** 2, 0)
  );
  expect(variances[0]).toBeGreaterThanOrEqual(variances[1] ?? 0);
  expect(variances[1]).toBeGreaterThanOrEqual(variances[2] ?? 0);
});

test("PCA retains radial distance: an outlier stays farther from the mean", () => {
  const points = pcaOf([
    [-4, 0],
    [0, 0],
    [1, 0],
    [3, 0],
  ]);
  expect(Math.hypot(...(points[0] ?? []))).toBeGreaterThan(
    Math.hypot(...(points[2] ?? []))
  );
  const repeated = [
    [1, 0, 0, 0],
    [-1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, -1, 0, 0],
  ];
  expect(pcaOf(repeated)).toEqual(pcaOf(repeated));
  for (const point of pcaOf(repeated)) {
    expect(Math.hypot(...point)).toBeCloseTo(1, 8);
  }
});
