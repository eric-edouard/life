import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  intelligenceRuns,
  type JobState,
  transcriptionJobs,
} from "@lifelog/db/schema";
import { createApp } from "./app";
import { ownerTimeZone, setOwnerTimeZone } from "./config";
import { services } from "./services";
import { fakeElevenLabs, OWNER_TOKEN, testConfig, testDb } from "./testing";
import { usageSummary } from "./usage";

const fake = fakeElevenLabs();
const config = testConfig(`http://localhost:${fake.server.port}`);
let env: Awaited<ReturnType<typeof testDb>>;

beforeAll(() => {
  env = testDb();
  setOwnerTimeZone("Asia/Jakarta");
});
afterAll(() => {
  setOwnerTimeZone(null);
  env.drop();
  fake.server.stop(true);
});
beforeEach(() => {
  env.reset();
  fake.respond = () => new Response("down", { status: 503 });
});

// 12:00 on 8 October in Jakarta (UTC+7).
const NOW = new Date("2026-10-08T05:00:00Z");

const job = (
  state: JobState,
  seconds: number,
  admittedAt: string,
  flags: { maybeBilled?: boolean } = {}
) =>
  env.db
    .insert(transcriptionJobs)
    .values({
      ...flags,
      admittedAt: new Date(admittedAt),
      audioSha256: randomUUID(),
      billableSeconds: seconds,
      preparedDurationSeconds: seconds,
      settings: { keyterms: [], languageCode: null, numSpeakers: null },
      settingsHash: randomUUID(),
      state,
    })
    .run();

const run = (
  provider: "openai" | "anthropic",
  state: "valid" | "failed" | "running",
  costUsd: number | null,
  createdAt: string
) =>
  env.db
    .insert(intelligenceRuns)
    .values({
      conversationId: randomUUID(),
      costUsd,
      createdAt: new Date(createdAt),
      model: "m",
      promptVersion: 1,
      provider,
      state,
      turns: [],
    })
    .run();

test("days are Jakarta days; maybe-billed jobs count", async () => {
  job("completed", 3600, "2026-10-07T17:00:00Z"); // 8 Oct 00:00 local
  // 7 Oct 23:59 local
  job("completed", 1800, "2026-10-07T16:59:59Z", { maybeBilled: true });
  // 1 Oct local, still September in UTC
  job("queued", 900, "2026-09-30T17:30:00Z", { maybeBilled: true });
  job("completed", 600, "2026-09-30T16:00:00Z"); // 30 Sep local: not this month
  job("failed", 7200, "2026-10-08T01:00:00Z"); // never reached ElevenLabs
  job("completed", 60, "2026-09-01T00:00:00Z"); // beyond 30 days

  const s = await usageSummary(env.db, config, NOW);

  expect(s.days).toHaveLength(30);
  expect(s.days.at(-1)?.date).toBe("2026-10-08");
  expect(s.days[0]?.date).toBe("2026-09-09");
  expect(s.today.transcription.hours).toBe(1);
  expect(s.today.transcription.usd).toBeCloseTo(0.2);
  const yesterday = s.days.at(-2);
  expect(yesterday?.transcription.hours).toBe(0.5);
  expect(s.thisMonth.transcription.hours).toBeCloseTo(1.75);
  expect(s.last30Days.transcription.hours).toBeCloseTo(1.75 + 600 / 3600);
  expect(s.monthStart).toBe("2026-09-30T17:00:00.000Z");
  expect(s.elevenLabsThisMonth).toBeNull();
});

test("summaries by provider and unpriced runs", async () => {
  run("openai", "valid", 0.1, "2026-10-08T03:00:00Z");
  run("anthropic", "failed", 0.05, "2026-10-07T10:00:00Z");
  run("openai", "valid", null, "2026-10-08T04:00:00Z");
  run("anthropic", "running", null, "2026-10-08T04:30:00Z");

  const s = await usageSummary(env.db, config, NOW);

  expect(s.today.intelligence.byProvider).toEqual({
    anthropic: 0,
    "claude-code": 0,
    codex: 0,
    openai: 0.1,
  });
  expect(s.today.intelligence.unpricedRuns).toBe(1);
  expect(s.thisMonth.intelligence.usd).toBeCloseTo(0.15);
  expect(s.today.totalUsd).toBeCloseTo(0.1);
});

test("ElevenLabs' own monthly figure, when it answers, sits beside ours", async () => {
  fake.respond = () =>
    Response.json({
      column_types: ["String", "DateTime", "Float", "Float"],
      column_units: [null, null, "min", "usd"],
      columns: ["product_type", "timestamp", "total_minutes", "total_cost"],
      rows: [
        ["STT", "2026-09-30T17:00:00Z", 30, 0.11],
        ["STT", "2026-10-01T17:00:00Z", 60, 0.22],
      ],
    });
  const s = await usageSummary(env.db, config, NOW);
  expect(s.elevenLabsThisMonth?.hours).toBeCloseTo(1.5);
  expect(s.elevenLabsThisMonth?.usd).toBeCloseTo(0.33);
  expect(fake.calls.at(-1)?.path).toBe(
    "/v1/workspace/analytics/query/usage-by-product-over-time"
  );
});

test("owner only", async () => {
  const app = createApp(services(config, env.db, { intelligence: null }));
  expect((await app.request("/usage/summary")).status).toBe(401);
  const res = await app.request("/usage/summary", {
    headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).days).toHaveLength(30);
});

test("a zone that isn't an IANA name never becomes the owner's", () => {
  setOwnerTimeZone("Asia/Jakarta'; drop table events; --");
  expect(ownerTimeZone()).toBe("UTC");
  setOwnerTimeZone(null);
});
