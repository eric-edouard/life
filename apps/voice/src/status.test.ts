// GET /status: what the owner's sessions read about capture and processing.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  conversations,
  intelligenceRuns,
  type JobState,
  macWatch,
  speechFragments,
  transcriptionJobs,
} from "@life/voice-db/schema";
import { createApp } from "./app";
import { sha256Hex } from "./config";
import {
  storeDiagnostic,
  storeHeartbeat,
  storeServerError,
} from "./diagnostics";
import { idle } from "./dictation";
import { record } from "./events";
import type { Job } from "./jobs";
import { services } from "./services";
import { setSwitches } from "./switches";
import { OWNER_TOKEN, testConfig, testDb } from "./testing";

let env: Awaited<ReturnType<typeof testDb>>;
beforeAll(() => {
  env = testDb();
});
afterAll(() => {
  env?.drop();
});

test("status gives the Pendant, the phone, the Mac, the chain's steps and the day's problems", async () => {
  const app = createApp(
    services(testConfig("http://localhost:1"), env.db, { intelligence: null })
  );
  const observedAt = "2026-10-01T02:30:00.000Z";
  storeHeartbeat(env.db, {
    build: {
      appBuild: "1",
      appVersion: "1.0",
      device: "iPhone17,1",
      os: "iOS 27",
    },
    connection: { since: observedAt, state: "ready" },
    id: randomUUID(),
    incidents: [],
    observedAt,
    pendant: { batteryPercent: 64, charging: "charging" },
    phone: { lowPowerMode: false },
    reason: "periodic",
    recording: {
      lastKnown: "recording",
      lastKnownAt: "2026-10-01T02:29:00.000Z",
      state: "recording",
    },
    sync: "caught_up",
    wakes: {
      bytes24h: 0,
      duplicates24h: 0,
      last24h: 0,
      pagesSaved24h: 0,
    },
  });
  env.db
    .insert(macWatch)
    .values({
      heardAt: new Date(observedAt),
      state: { ...idle, asleep: true },
    })
    .run();
  storeServerError(env.db, new Error("boom"), {
    appBuild: "dev",
    method: "GET",
    route: "/x",
  });
  storeDiagnostic(env.db, {
    begin: observedAt,
    binaries: [],
    build: { appBuild: "dev", appVersion: "1", device: "iPhone", os: "27" },
    callStacks: [],
    end: observedAt,
    error: { count: 5, message: "x", type: "y" },
    id: randomUUID(),
    kind: "app_error",
    truncated: false,
  });
  record(env.db, "apns.sent", { status: 410 });
  record(env.db, "apns.sent", { status: 200 });
  const status = await (
    await app.request("/status", {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    })
  ).json();
  expect(status.lastStepsLast24h["apns.sent"]).toMatchObject({
    count: 2,
    status: 200,
  });
  expect(status.pendant).toEqual({
    batteryPercent: 64,
    charging: "charging",
    connection: "ready",
    knownAt: observedAt,
    recording: "recording",
    recordingKnownAt: "2026-10-01T02:29:00.000Z",
  });
  expect(status.phoneHeartbeat.sync).toBe("caught_up");
  expect(status.mac).toMatchObject({
    asleep: true,
    connected: false,
    dictatingSince: null,
    state: "asleep",
  });
  expect(status.problemsLast24h.server_error).toBeGreaterThanOrEqual(1);
  // An app error stands for its repeats.
  expect(status.problemsLast24h.app_error).toBeGreaterThanOrEqual(5);
});

test("status's pipeline: blocks waiting and at ElevenLabs, open speech, failures, summaries", async () => {
  env.reset();
  const s = services(testConfig("http://localhost:1"), env.db, {
    intelligence: null,
  });
  // Summaries on (off by default), so they wait for the Mac.
  setSwitches(env.db, { ai: true });
  const now = Date.now();
  const job = (state: JobState, seconds: number, at: Partial<Job> = {}) => ({
    audioSha256: randomUUID(),
    billableSeconds: seconds,
    preparedDurationSeconds: seconds,
    settings: { keyterms: [], languageCode: null, numSpeakers: null },
    settingsHash: randomUUID(),
    state,
    ...at,
  });
  env.db
    .insert(transcriptionJobs)
    .values([
      job("queued", 60),
      job("queued", 30),
      job("submitted", 90, { requestSentAt: new Date(now - 60_000) }),
      job("submitted", 90, { requestSentAt: new Date(now - 5000) }),
      job("failed", 10),
      job("completed", 20, { completedAt: new Date(now - 1000) }),
    ])
    .run();
  env.db
    .insert(speechFragments)
    .values({
      audioSha256: randomUUID(),
      captureEnd: new Date(now),
      captureStart: new Date(now - 10_000),
      map: {
        segments: [
          [now - 10_000, now - 7000],
          [now - 2000, now],
        ],
        separatorMs: 400,
      },
      objectKey: "fragments/x/1-a.ogg",
      pages: [[1, 2]],
      sourceId: "x",
    })
    .run();
  const [titled, waiting] = [randomUUID(), randomUUID()];
  env.db
    .insert(conversations)
    .values(
      [titled, waiting].map((id) => ({
        captureEndedAt: new Date(now),
        captureStartedAt: new Date(now - 60_000),
        id,
        ownerTitle: id === titled ? "Lunch" : null,
      }))
    )
    .run();
  const run = (
    conversationId: string,
    state: "running" | "valid" | "waiting",
    createdAt: number
  ) => ({
    conversationId,
    createdAt: new Date(createdAt),
    model: "m",
    promptVersion: 1,
    provider: "claude-code" as const,
    state,
    turns: [],
  });
  env.db
    .insert(intelligenceRuns)
    .values([
      run(waiting, "valid", now - 2000),
      run(titled, "running", now - 1000),
      run(waiting, "waiting", now - 1000),
    ])
    .run();
  await s.rolling.drain();
  const { pipeline } = await (
    await createApp(s).request("/status", {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    })
  ).json();
  expect(pipeline.transcription).toEqual({
    atProvider: {
      jobs: 2,
      oldestSentAt: new Date(now - 60_000).toISOString(),
    },
    failedLast24h: 1,
    fragments: { seconds: 5 },
    lastTranscriptAt: new Date(now - 1000).toISOString(),
    waiting: { blocks: 2, seconds: 90 },
  });
  expect(pipeline.ai).toMatchObject({
    // No Mac connected.
    blockedBy: "macAway",
    running: [
      {
        conversationId: titled,
        startedAt: new Date(now - 1000).toISOString(),
        title: "Lunch",
      },
    ],
    waiting: 1,
  });
  expect(pipeline.ai.lastSummaryAt).not.toBeNull();
  // Summaries off (the default): none is coming, so nothing blocks them.
  setSwitches(env.db, { ai: false });
  const off = await (
    await createApp(s).request("/status", {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    })
  ).json();
  expect(off.pipeline.ai.blockedBy).toBeNull();
});

test("the live status is the cheap part, for the device token only", async () => {
  const read = "reader-token";
  const app = createApp(
    services(
      testConfig("http://localhost:1", { READ_TOKEN_HASH: sha256Hex(read) }),
      env.db,
      { intelligence: null }
    )
  );
  const get = (path: string, token: string) =>
    app.request(path, { headers: { Authorization: `Bearer ${token}` } });
  const live = await (await get("/status/live", OWNER_TOKEN)).json();
  expect(Object.keys(live).sort()).toEqual([
    "backup",
    "identity",
    "mac",
    "pendant",
    "phoneHeartbeat",
    "pipeline",
    "switches",
    "transcription",
  ]);
  expect(Object.keys(live.transcription)).toEqual(["quota"]);
  // No IDENTITY_URL: speaker recognition is off, and says so.
  expect(live.identity).toEqual({
    configured: false,
    lastError: null,
    lastOkAt: null,
  });
  expect((await get("/status/live", read)).status).toBe(403);
  const full = await (await get("/status", read)).json();
  expect(full.pipeline).toEqual(live.pipeline);
  expect(full.transcription.latency).toBeDefined();
});
