import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { people, voiceProfiles, voiceSamples } from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { mintToken } from "../scripts/mint-token";
import { createApp } from "./app";
import { loadConfig, RECOGNITION, sha256Hex } from "./config";
import { queueCache } from "./naming-queue";
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

test("named clouds cap newest exemplars per person/model on centroid-fitted axes", () => {
  const { owner, guest, cards } = seedMap();
  const jobId = seedTranscript(env.db, []);
  // Insert out of time order: the display follows creation time, not insertion order.
  const samples = env.db
    .insert(voiceSamples)
    .values(
      Array.from({ length: 502 }, (_, i) => ({
        conversationId: randomUUID(),
        createdAt: new Date(4_102_444_800_000 + ((i * 251) % 503) * 1000),
        durationSeconds: 10,
        embedding: [Math.cos(i / 100), Math.sin(i / 100), 0],
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
    .insert(voiceProfiles)
    .values(
      samples.map((s) => ({
        personId: owner,
        sampleId: s.id,
      }))
    )
    .run();
  const otherModel = env.db
    .select()
    .from(voiceSamples)
    .where(eq(voiceSamples.modelId, "second"))
    .get();
  expect(otherModel).toBeDefined();
  env.db
    .insert(voiceProfiles)
    .values({ personId: owner, sampleId: otherModel?.id ?? "" })
    .run();
  const before = env.db.$client.serialize();
  const result = readVoiceMap(env.db, cards);
  const points = result.models[0]?.points ?? [];
  const ownerPoints = points.filter((p) => p.personId === owner);
  const guestPoints = points.filter((p) => p.personId === guest);
  const second = result.models.find((m) => m.model === "second@r2");
  expect(second?.points.filter((p) => p.personId === owner)).toHaveLength(2);
  expect(second?.points).toHaveLength(3);
  expect(ownerPoints).toHaveLength(501);
  expect(guestPoints).toHaveLength(2);
  expect(new Set(points.map((p) => p.id)).size).toBe(points.length);
  const vectors = [
    centroid([[1, 0, 0], ...samples.map((s) => s.embedding)]),
    [0, 1, 0],
    [0.8, 0.6, 0],
  ];
  const exemplars = samples
    .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 500)
    .map((s) => s.embedding);
  const expected = pcaOf(vectors, [...vectors, ...exemplars]);
  for (const [i, p] of points.slice(0, 3).entries()) {
    for (let axis = 0; axis < 3; axis += 1) {
      expect(p.position[axis]).toBeCloseTo(expected[i]?.[axis] ?? 0, 8);
    }
  }
  for (const [i, p] of ownerPoints.slice(1).entries()) {
    expect(p.ranking).toEqual([]);
    expect(p.words).toBe(0);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(p.position[axis]).toBeCloseTo(expected[i + 3]?.[axis] ?? 0, 8);
    }
  }
  expect(env.db.$client.serialize()).toEqual(before);
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
  ]);
  expect(traces[0].marker.size).toEqual([9, 3]);
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
