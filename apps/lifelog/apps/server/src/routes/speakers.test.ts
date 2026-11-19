import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  people,
  speakerAssignments,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { createApp } from "../app";
import { sha256Hex } from "../config";
import { readProfiles } from "../people";
import { services } from "../services";
import { rankPeople } from "../speakers";
import {
  OWNER_TOKEN,
  seedConversation,
  seedTranscript,
  testConfig,
  testDb,
} from "../testing";

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

const server = () =>
  createApp(
    services(
      testConfig("http://localhost:1", {
        READ_TOKEN_HASH: sha256Hex("reader"),
      }),
      env.db,
      { intelligence: null }
    )
  );
const span = (to = "2026-10-01T03:00:00Z") =>
  `/speakers/voices?from=2026-10-01T02:00:00Z&to=${to}`;
const get = (path: string, token?: string) =>
  server().request(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

// A person with one evidence clip per [conversation, embedding].
function person(name: string, clips: [string, number[]][]) {
  const id = randomUUID();
  env.db.insert(people).values({ id, name }).run();
  const jobId = seedTranscript(env.db, []);
  clips.forEach(([conversationId, embedding], turnIndex) => {
    const sample = env.db
      .insert(voiceSamples)
      .values({
        conversationId,
        durationSeconds: 10,
        embedding,
        jobId,
        modelId: "m",
        modelRevision: "r",
        speakerLabel: "x",
        turnIndex,
      })
      .returning()
      .get();
    env.db
      .insert(voiceProfiles)
      .values({ personId: id, sampleId: sample?.id ?? "" })
      .run();
  });
  return id;
}

function seed() {
  const conversation = randomUUID();
  const near = person("Near", [[randomUUID(), [0.1, 1, 0]]]);
  // The span's own conversation holds a perfect match for the voice; nobody else holds a clip of them.
  const own = person("Own", [[conversation, [0, 1, 0]]]);
  const turn = (speakerId: string, i: number) => ({
    end: i * 10 + 9,
    speakerId,
    start: i * 10,
    text: `made-up words ${i}`,
  });
  const { jobId } = seedConversation(
    env.db,
    ["a", "b", "c", "c", "d", "e", "f"].map(turn),
    { id: conversation }
  );
  env.db
    .insert(voiceSamples)
    .values(
      [2, 3].map((turnIndex) => ({
        conversationId: conversation,
        durationSeconds: 5,
        embedding: [0, 1, 0],
        jobId,
        modelId: "m",
        modelRevision: "r",
        speakerLabel: "c",
        turnIndex,
      }))
    )
    .run();
  const row = (
    speakerLabel: string,
    status: "person" | "unknown" | "not_relevant" | "stranger",
    source: "owner" | "recognized",
    personId: string | null,
    mixed = false
  ) => ({ jobId, mixed, personId, source, speakerLabel, status });
  env.db
    .insert(speakerAssignments)
    .values([
      row("a", "person", "owner", own),
      row("b", "person", "recognized", near),
      row("e", "not_relevant", "owner", null),
      row("f", "unknown", "owner", null, true),
      row("d", "stranger", "recognized", null),
    ])
    .run();
  return { jobId, near, own };
}

test("each label says who answered it, its status and whom it sounds like, never itself", async () => {
  const { jobId, near, own } = seed();
  const res = await get(span(), "reader");
  expect(res.status).toBe(200);
  const rows = (await res.json()) as {
    basis: string | null;
    jobId: string;
    likeness: { personId: string; score: number }[];
    mixed: boolean;
    personId: string | null;
    speakerLabel: string;
    status: string | null;
  }[];
  const by = Object.fromEntries(rows.map((r) => [r.speakerLabel, r]));
  expect(rows.map((r) => r.speakerLabel).sort()).toEqual([
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
  ]);
  expect(rows.every((r) => r.jobId === jobId)).toBe(true);
  expect(by.a).toMatchObject({
    basis: "owner",
    personId: own,
    status: "person",
  });
  expect(by.b).toMatchObject({ basis: "recognized", personId: near });
  expect(by.e).toMatchObject({
    basis: "owner",
    personId: null,
    status: "not_relevant",
  });
  expect(by.d).toMatchObject({
    basis: null,
    personId: null,
    status: "stranger",
  });
  expect(by.f).toMatchObject({ basis: "owner", mixed: true });
  expect(by.a?.mixed).toBe(false);
  // Unnamed: with a vector it has a likeness, without one it has none.
  expect(by.c).toMatchObject({ basis: null, personId: null, status: null });
  expect(by.c?.likeness.map((l) => l.personId)).toEqual([near]);
  expect(by.d?.likeness).toEqual([]);
  // Judged with the span's own exemplars, the other person would match perfectly.
  const all = readProfiles(env.db).get("m@r")?.people ?? [];
  expect(rankPeople([0, 1, 0], all)[0]?.personId).toBe(own);
});

test("a span over 24 hours or a malformed instant is refused, and so is a missing token", async () => {
  seed();
  expect((await get(span("2026-10-02T02:00:01Z"), "reader")).status).toBe(400);
  expect((await get(span("2026-10-02T02:00:00Z"), "reader")).status).toBe(200);
  expect((await get(span("soon"), "reader")).status).toBe(400);
  expect((await get(span("2026-10-01T01:00:00Z"), "reader")).status).toBe(400);
  expect((await get(span())).status).toBe(401);
  expect((await get(span(), "nobody")).status).toBe(401);
  expect((await get(span(), OWNER_TOKEN)).status).toBe(200);
  expect(
    ((await (await get(span(), "reader")).json()) as unknown[]).length
  ).toBeGreaterThan(0);
});

test("a span with no turns answers nothing, and the call writes nothing", async () => {
  const before = env.db.$client.serialize();
  seed();
  const seeded = env.db.$client.serialize();
  const empty = await get(
    "/speakers/voices?from=2026-11-01T00:00:00Z&to=2026-11-01T01:00:00Z",
    "reader"
  );
  expect(await empty.json()).toEqual([]);
  await get(span(), "reader");
  expect(env.db.$client.serialize()).toEqual(seeded);
  expect(seeded).not.toEqual(before);
});

test("a turn's clip is cut as a card's is, for one a client quotes; a turn nobody holds is 404", async () => {
  const { id, jobId } = seedConversation(env.db, [
    { end: 12, speakerId: "a", start: 0, text: "Ask Bastien about tiles" },
  ]);
  const res = await get(`/turns/clip?jobId=${jobId}&turnIndex=0`, OWNER_TOKEN);
  expect(res.status).toBe(200);
  const clip = (await res.json()) as { conversationId: string; text: string };
  expect(clip.conversationId).toBe(id);
  expect(clip).toHaveProperty("words");
  expect(
    (await get(`/turns/clip?jobId=${jobId}&turnIndex=9`, OWNER_TOKEN)).status
  ).toBe(404);
});
