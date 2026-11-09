import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  people,
  speakerAssignments,
  turns,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { mintToken } from "../scripts/mint-token";
import { createApp } from "./app";
import {
  loadConfig,
  RECOGNITION,
  sha256Hex,
  VOICE_MAP_POINTS_PER_PERSON_MODEL,
} from "./config";
import { queueCache } from "./naming-queue";
import { readProfiles } from "./people";
import { services } from "./services";
import { centroid, rankPeople } from "./speakers";
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
  env.db
    .insert(speakerAssignments)
    .values([
      {
        jobId,
        personId: owner,
        source: "owner",
        speakerLabel: "a",
        status: "person",
      },
      {
        jobId,
        personId: guest,
        source: "owner",
        speakerLabel: "b",
        status: "person",
      },
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

test("named sample clouds stride across time per person/model without changing recognition or PCA fit", () => {
  const { owner, guest, cards } = seedMap();
  const jobId = seedTranscript(env.db, []);
  const samples = env.db
    .insert(voiceSamples)
    .values(
      Array.from({ length: 907 }, (_, i) => ({
        conversationId: jobId,
        // Deliberately different from recording order: recovered samples can be created later.
        createdAt: new Date(4_102_444_800_000 + ((i * 251) % 907) * 1000),
        durationSeconds: 10,
        embedding: [Math.cos(i / 100), Math.sin(i / 100), 0],
        jobId,
        modelId: "first",
        modelRevision: "r1",
        speakerLabel: i < 502 ? "a" : "b",
        turnIndex: i,
      }))
    )
    .returning()
    .all();
  env.db
    .insert(turns)
    .values(
      samples.map((s, i) => ({
        endAt: new Date(4_102_444_800_000 + (i + 1) * 1000),
        jobId,
        language: "en",
        speakerLabel: s.speakerLabel,
        startAt: new Date(4_102_444_800_000 + i * 1000),
        text: "Made-up words",
        turnIndex: i,
        words: [],
      }))
    )
    .run();
  env.db
    .insert(speakerAssignments)
    .values([
      {
        jobId,
        personId: owner,
        source: "owner",
        speakerLabel: "a",
        status: "person",
      },
      {
        jobId,
        personId: guest,
        source: "recognized",
        speakerLabel: "b",
        status: "person",
      },
    ])
    .run();
  // Many samples in one conversation: clouds must not collapse into profile exemplars.
  env.db
    .insert(voiceProfiles)
    .values(
      samples
        .filter((s) => s.speakerLabel === "a")
        .map((s) => ({ personId: owner, sampleId: s.id }))
    )
    .run();
  const other = seedTranscript(env.db, []);
  env.db
    .insert(voiceSamples)
    .values({
      conversationId: other,
      durationSeconds: 10,
      embedding: [1, 0],
      jobId: other,
      modelId: "second",
      modelRevision: "r2",
      speakerLabel: "a",
      turnIndex: 0,
    })
    .run();
  env.db
    .insert(speakerAssignments)
    .values({
      jobId: other,
      personId: owner,
      source: "recognized",
      speakerLabel: "a",
      status: "person",
    })
    .run();
  const profiles = readProfiles(env.db);
  const before = env.db.$client.serialize();
  const result = readVoiceMap(env.db, cards);
  expect(readProfiles(env.db)).toEqual(profiles);
  expect(readVoiceMap(env.db, cards)).toEqual(result);
  const points =
    result.models.find((m) => m.model === "first@r1")?.points ?? [];
  for (const personId of [owner, guest]) {
    const cloud = points.filter(
      (p) => p.personId === personId && p.kind === "sample"
    );
    expect(cloud).toHaveLength(VOICE_MAP_POINTS_PER_PERSON_MODEL);
    const originals = env.db
      .select()
      .from(voiceSamples)
      .where(eq(voiceSamples.speakerLabel, personId === owner ? "a" : "b"))
      .all()
      .filter((s) => s.modelId === "first")
      .toSorted((a, b) =>
        a.jobId === jobId && b.jobId === jobId
          ? a.turnIndex - b.turnIndex
          : a.createdAt.getTime() - b.createdAt.getTime()
      );
    const selected = Array.from(
      { length: VOICE_MAP_POINTS_PER_PERSON_MODEL },
      (_, i) =>
        originals[
          Math.floor(
            (i * (originals.length - 1)) /
              (VOICE_MAP_POINTS_PER_PERSON_MODEL - 1)
          )
        ]
    );
    expect(cloud.map((p) => p.id)).toEqual(
      selected.flatMap((s) => (s ? [s.id] : []))
    );
    const fit = [
      ...(profiles.get("first@r1")?.people ?? []).map((p) =>
        centroid(p.exemplars)
      ),
      [0.8, 0.6, 0],
    ];
    const expected = pcaOf(
      fit,
      selected.map((s) => s?.embedding ?? [])
    );
    for (const [i, p] of cloud.entries()) {
      expect(p.ranking).toEqual([]);
      expect(p.words).toBe(0);
      for (let axis = 0; axis < 3; axis += 1) {
        expect(p.position[axis]).toBeCloseTo(expected[i]?.[axis] ?? 0, 8);
      }
    }
  }
  const second = result.models.find((m) => m.model === "second@r2");
  expect(
    second?.points.filter((p) => p.personId === owner && p.kind === "sample")
  ).toHaveLength(1);
  expect(new Set(points.map((p) => p.id)).size).toBe(points.length);
  expect(env.db.$client.serialize()).toEqual(before);
});

test("clouds resolve current sampled turns including overrides, excluding rejected and several-person fallbacks", () => {
  const { owner, guest } = seedMap();
  const jobId = seedTranscript(env.db, []);
  const samples = env.db
    .insert(voiceSamples)
    .values(
      Array.from({ length: 7 }, (_, i) => ({
        conversationId: jobId,
        durationSeconds: 10,
        embedding: [1, 0, 0],
        jobId,
        modelId: "first",
        modelRevision: "r1",
        speakerLabel: "a",
        turnIndex: i,
      }))
    )
    .returning()
    .all();
  env.db
    .insert(speakerAssignments)
    .values([
      {
        jobId,
        personId: owner,
        source: "recognized",
        speakerLabel: "a",
        status: "person",
      },
      {
        jobId,
        personId: guest,
        source: "owner",
        speakerLabel: "a",
        status: "person",
        turnIndex: 1,
      },
      {
        jobId,
        personId: guest,
        source: "recognized",
        speakerLabel: "a",
        status: "person",
        turnIndex: 2,
      },
      {
        jobId,
        source: "owner",
        speakerLabel: "a",
        status: "unknown",
        turnIndex: 3,
      },
      {
        jobId,
        source: "owner",
        speakerLabel: "a",
        status: "media",
        turnIndex: 4,
      },
      {
        jobId,
        source: "recognized",
        speakerLabel: "a",
        status: "stranger",
        turnIndex: 5,
      },
      {
        candidates: { people: [owner, guest], unknown: false },
        jobId,
        personId: owner,
        source: "owner",
        speakerLabel: "a",
        status: "person",
        turnIndex: 6,
      },
    ])
    .run();
  const points = readVoiceMap(env.db, []).models.flatMap((m) => m.points);
  for (const [i, sample] of samples.entries()) {
    const point = points.find((p) => p.id === sample.id);
    if (i >= 3) {
      expect(point).toBeUndefined();
    } else {
      expect(point?.kind).toBe("sample");
      expect(point?.personId).toBe(i === 0 ? owner : guest);
      expect(point?.basis).toBe(i === 1 ? "owner" : "recognized");
    }
  }
});

test("no map point carries a vector or embedding", () => {
  const { cards } = seedMap();
  const points = readVoiceMap(env.db, cards).models.flatMap((m) => m.points);
  expect(new Set(points.map((p) => p.kind))).toEqual(
    new Set(["centroid", "sample", "unnamed"])
  );
  for (const point of points) {
    expect(Object.keys(point).sort()).toEqual([
      "basis",
      "id",
      "kind",
      "personId",
      "position",
      "ranking",
      "words",
    ]);
    expect(point).not.toHaveProperty("vector");
    expect(point).not.toHaveProperty("embedding");
  }
});

test("PCA projects extra vectors without changing its fit, including empty and deficient fits", () => {
  const fit = [
    [-1, 0],
    [1, 0],
  ];
  expect(pcaOf(fit, [...fit, [100, 100]])).toEqual([
    [-1, 0, 0],
    [1, 0, 0],
    [100, 0, 0],
  ]);
  expect(pcaOf([], [[1, 2]])).toEqual([[0, 0, 0]]);
  expect(pcaOf([[1, 2]], [[3, 4]])).toEqual([[0, 0, 0]]);
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

test("sidebar toggles whole clouds independently, keeps choices on refresh and preserves naming", async () => {
  const { cards, owner, guest } = seedMap();
  const data = readVoiceMap(env.db, cards);
  // Point kind, not the id shape, chooses centroid size; basis chooses solid/hollow.
  const [model] = data.models;
  const ownerSample = model?.points.find(
    (p) => p.kind === "sample" && p.personId === owner
  );
  if (!(model && ownerSample)) {
    throw new Error("Missing seeded cloud");
  }
  for (const point of model.points) {
    if (point.kind === "centroid" && point.personId === owner) {
      point.id = "not-a-person-id";
    }
  }
  model.points.push({ ...ownerSample, basis: "recognized", id: owner });
  // Duplicate display names must still toggle different people.
  for (const person of data.people) {
    person.name = "Made-up name";
  }
  const loaded = Promise.withResolvers<void>();
  const nodes = new Map();
  const noop = () => undefined;
  const node = () => ({
    addEventListener: noop,
    append(...children: unknown[]) {
      this.children.push(...children);
    },
    children: [] as any[],
    click: null as any,
    hidden: true,
    on(_event: string, action: unknown) {
      this.click = action;
    },
    pause: noop,
    querySelectorAll() {
      return this.children.map((label) => label.children[0]);
    },
    removeAllListeners: noop,
    removeAttribute: noop,
    replaceChildren(...children: unknown[]) {
      this.children = children;
    },
    setAttribute: noop,
    style: {},
    value: "first@r1",
  });
  const el = (id: string) => {
    if (!nodes.has(id)) {
      nodes.set(id, node());
    }
    return nodes.get(id);
  };
  let traces: any[] = [];
  let layout: any;
  const restyles: unknown[] = [];
  const plotly = {
    react(_plot: unknown, next: any[], nextLayout: unknown) {
      traces = next;
      layout = nextLayout;
      return Promise.resolve();
    },
    restyle(_plot: unknown, value: unknown, indices: unknown) {
      restyles.push([value, indices]);
      return Promise.resolve();
    },
  };
  Object.defineProperty(el("status"), "textContent", {
    set(value) {
      if (value === "") {
        loaded.resolve();
      } else {
        loaded.reject(new Error(value));
      }
    },
  });
  runInNewContext(
    readFileSync(new URL("./voices/page.js", import.meta.url), "utf8"),
    {
      document: {
        createElement: node,
        createTextNode: (text: string) => text,
        getElementById: el,
      },
      fetch: () =>
        Promise.resolve({ json: () => Promise.resolve(data), ok: true }),
      history: { replaceState: noop },
      location: { hash: "#token=made-up-token", pathname: "/voices" },
      URLSearchParams,
      window: { addEventListener: noop, Plotly: plotly },
    }
  );
  await loaded.promise;
  const checkboxes = el("visibility").querySelectorAll();
  expect(checkboxes).toHaveLength(3);
  expect(layout.showlegend).toBe(false);
  expect(traces.find((t) => t.customdata[0] === owner)?.customdata).toEqual([
    owner,
    owner,
    owner,
  ]);
  expect(traces[0].marker.size).toEqual([9, 3, 3]);
  expect(traces[0].marker.symbol).toEqual(["circle", "circle", "circle-open"]);
  expect(traces.find((t) => t.customdata[0] === guest)?.customdata).toEqual([
    guest,
    guest,
  ]);
  checkboxes[0].checked = false;
  checkboxes[0].onchange();
  expect(restyles.at(-1)).toEqual([{ visible: false }, [0]]);
  expect(checkboxes[1].checked).toBe(true);
  await el("refresh").onclick();
  expect(traces.map((t) => t.visible)).toEqual([false, true, true]);
  el("show-none").onclick();
  expect(
    el("visibility")
      .querySelectorAll()
      .every((c: any) => !c.checked)
  ).toBe(true);
  el("show-all").onclick();
  await el("refresh").onclick();
  expect(traces.map((t) => t.visible)).toEqual([true, true, true]);
  el("plot").click({ points: [{ customdata: "group" }] });
  expect(el("detail").hidden).toBe(false);
  expect(el("context").textContent).toContain("420 words");
});
