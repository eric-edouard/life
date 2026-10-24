import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { countRows, MIGRATIONS } from "@lifelog/db";
import {
  conversations,
  events,
  heartbeats,
  macWatch,
  people,
  quietRanges,
  sources,
  transcriptionJobs,
  transcripts,
  turns,
} from "@lifelog/db/schema";
import { eq, sql } from "drizzle-orm";
import { phoneNudger, storePushToken } from "./apns";
import { createApp } from "./app";
import { pendantOggOpus } from "./audio";
import { blockKey, memoryAudioStore } from "./audio-store";
import { sha256Hex } from "./config";
import { admit, bought, storeFragment } from "./cutter";
import { idle } from "./dictation";
import { PARSER_VERSION } from "./elevenlabs";
import { getJob, jobWorker } from "./jobs";
import { askForUploads, latency, spread } from "./latency";
import { macSocket, vouchedThrough } from "./mac-socket";
import { services } from "./services";
import { setSwitches } from "./switches";
import {
  fakeElevenLabs,
  fakeSpeechService,
  OWNER_TOKEN,
  oggOpus,
  providerTranscript,
  seedTranscript,
  signature,
  testConfig,
  testDb,
} from "./testing";
import { rebuildTurns } from "./turns";
import { blockKeyterms } from "./vocabulary";

const fake = fakeElevenLabs();
const baseUrl = `http://localhost:${fake.server.port}`;
const speech = fakeSpeechService();
const withSpeech = {
  IDENTITY_SECRET: "speech-test-secret",
  IDENTITY_URL: `http://localhost:${speech.server.port}`,
};
let env: Awaited<ReturnType<typeof testDb>>;

beforeAll(() => {
  env = testDb();
});
afterAll(() => {
  env.drop();
  fake.server.stop(true);
  speech.server.stop(true);
});
const accept = () =>
  Response.json(
    {
      message: "ok",
      request_id: `req_${randomUUID()}`,
      transcription_id: `tr_${randomUUID()}`,
    },
    { status: 202 }
  );
beforeEach(() => {
  env.reset();
  fake.calls.length = 0;
  fake.respond = accept;
  speech.blocks = 0;
  speech.busy = false;
  speech.failing = false;
  speech.meanwhile = () => undefined;
});

// The app with its own bucket and worker; `s.worker.work()` waits for what it sends.
const appWith = (
  overrides: Record<string, string | undefined> = {},
  bucket = memoryAudioStore()
) => {
  const s = services(testConfig(baseUrl, overrides), env.db, {
    audio: bucket,
  });
  return Object.assign(createApp(s), { audio: bucket, s });
};
// The audio of the last upload ElevenLabs got.
const sentAudio = () => {
  const file = uploads().at(-1)?.form?.get("file");
  return file instanceof Blob ? file.bytes() : null;
};
type App = ReturnType<typeof appWith>;
const auth = { Authorization: `Bearer ${OWNER_TOKEN}` };
// What was sent to be transcribed (the usage summary posts a query too).
const uploads = () =>
  fake.calls.filter(
    (c) => c.method === "POST" && c.path.endsWith("/speech-to-text")
  );
const jobRow = (id: string) => {
  const job = getJob(env.db, id);
  if (!job) {
    throw new Error(`no job ${id}`);
  }
  return job;
};
const due = (id: string) =>
  env.db.run(
    sql`update transcription_jobs set next_attempt_at = ${Date.now() - 1000} where id = ${id}`
  );

function audio(seconds = 600) {
  const data = oggOpus(seconds);
  return { data, seconds, sha: sha256Hex(data) };
}

const T0 = Date.parse("2026-10-12T10:00:00Z");
const SOURCE = "pendant-1";

// `a` as the phone sends speech: one fragment of pages `firstPage`…+9, its audio a minute a page
// from T0 (page 1) unless `segments` say. Its row, or why it wasn't kept.
function keep(
  app: App,
  a: ReturnType<typeof audio>,
  firstPage: number,
  segments?: [number, number][]
) {
  const start = T0 + (firstPage - 1) * 60_000;
  const map = {
    segments: segments ?? [[start, start + a.seconds * 1000]],
    separatorMs: 400,
  };
  const pages: [number, number][] = [[firstPage, firstPage + 9]];
  const upload = { audioSha256: a.sha, map, pages, sourceId: SOURCE };
  return storeFragment(env.db, app.audio, upload, a.data);
}

// The job of that fragment alone, admitted as the cutter does but with its audio as it is (the
// cutter's join needs real Opus packets: cutter.test.ts). Queued: `worker.work()` sends it.
async function admitFragment(...args: Parameters<typeof keep>) {
  const [app, a] = args;
  const fragment = await keep(...args);
  if (typeof fragment === "string") {
    throw new Error(fragment);
  }
  if (fragment.jobId) {
    return fragment.jobId;
  }
  const objectKey = blockKey(SOURCE, fragment.pages[0]?.[0] ?? 0, a.sha);
  await app.audio.put(objectKey, a.data);
  await app.audio.delete(fragment.objectKey ?? "");
  const settings = { keyterms: blockKeyterms(env.db) };
  const job = admit(
    env.db,
    {
      ...fragment,
      endedOnSilence: true,
      objectKey,
      preparedDurationSeconds: a.seconds,
      settings: { ...settings, languageCode: null, numSpeakers: null },
    },
    [fragment.id]
  );
  return job.id;
}

const deliver = (app: App, payload: unknown) => {
  const body = JSON.stringify(payload);
  return app.request("/webhooks/elevenlabs", {
    body,
    headers: { "ElevenLabs-Signature": signature(body) },
    method: "POST",
  });
};

const completeByWebhook = (
  app: App,
  job: { id: string; providerRequestId: string | null }
) =>
  deliver(app, {
    data: {
      request_id: job.providerRequestId,
      transcription: providerTranscript,
      webhook_metadata: JSON.stringify({ jobId: job.id }),
    },
    type: "speech_to_text_transcription",
  });

test("owner token is required except for health and webhook", async () => {
  const app = appWith();
  const usage = "/usage/summary";
  expect((await app.request(usage)).status).toBe(401);
  expect(
    (await app.request(usage, { headers: { Authorization: "Bearer nope" } }))
      .status
  ).toBe(401);
  expect((await app.request(usage, { headers: auth })).status).toBe(200);
  expect((await app.request("/health")).status).toBe(200);
});

test("page ranges round-trip, and admission never buys a page a job holds, failed or not", () => {
  const request = (pages: [number, number][]) => ({
    audioSha256: randomUUID(),
    endedOnSilence: true,
    map: {
      segments: [[T0, T0 + 1000]] as [number, number][],
      separatorMs: 400,
    },
    objectKey: "k",
    pages,
    preparedDurationSeconds: 1,
    settings: { keyterms: [], languageCode: null, numSpeakers: null },
    sourceId: SOURCE,
  });
  const first = admit(
    env.db,
    request([
      [1200, 1290],
      [1293, 1301],
    ]),
    []
  );
  expect(jobRow(first.id).pages).toEqual([
    [1200, 1290],
    [1293, 1301],
  ]);

  // Overlapping by one page: refused.
  expect(() => admit(env.db, request([[1301, 1310]]), [])).toThrow("held");
  // The gap between its ranges is free.
  expect(admit(env.db, request([[1291, 1292]]), []).pages).toEqual([
    [1291, 1292],
  ]);
  // A failed job's pages stay its own: paid work happens once.
  env.db
    .update(transcriptionJobs)
    .set({ state: "failed" })
    .where(eq(transcriptionJobs.id, first.id))
    .run();
  expect(() => admit(env.db, request([[1301, 1310]]), [])).toThrow("held");
});

test("block keyterms are the vocabulary then the people, and a new person never buys a block twice", async () => {
  const app = appWith();
  // The owner's list, whole each time: sent again, nothing changes.
  const words = (terms: string[]) =>
    app.request("/vocabulary", {
      body: JSON.stringify({ terms }),
      headers: { ...auth, "Content-Type": "application/json" },
      method: "PUT",
    });
  await words(["Oakridge", "Lifelog"]);
  for (const _ of [1, 2]) {
    // biome-ignore lint/performance/noAwaitInLoops: the same request twice, in order
    expect(await (await words(["Lifelog"])).json()).toEqual({
      terms: ["Lifelog"],
    });
  }
  expect((await words(["<bad>"])).status).toBe(400);
  expect(
    (await (await app.request("/changes", { headers: auth })).json()).vocabulary
  ).toEqual(["Lifelog"]);
  env.db
    .insert(people)
    .values([
      { aliases: ["Jojo", "lifelog"], name: "Marie-Jo" },
      { name: "Nok" },
    ])
    .run();
  const a = audio(300);
  const jobId = await admitFragment(app, a, 1200);
  expect(jobRow(jobId).settings.keyterms).toEqual([
    "Lifelog",
    "Marie-Jo",
    "Jojo",
    "Nok",
  ]);
  // Sent again with new keyterms: the same fragment, and its job.
  env.db.insert(people).values({ name: "Théo" }).run();
  expect(await keep(app, a, 1200)).toMatchObject({ jobId });
  expect(countRows(env.db, transcriptionJobs)).toBe(1);

  // Never more than the provider takes.
  env.db
    .insert(people)
    .values(Array.from({ length: 120 }, (_, i) => ({ name: `Person ${i}` })))
    .run();
  expect(blockKeyterms(env.db)).toHaveLength(100);
});

test("a job past the Mac's watermark waits queued in the worker too, then goes once the Mac vouches", async () => {
  const app = appWith();
  const jobId = await admitFragment(app, audio(60), 1);
  // The Mac is awake and heard, its watermark 30 s into the minute: a dictation there isn't a
  // range yet.
  const finished = { end: T0 + 35_000, source: "claude", start: T0 + 31_000 };
  env.db
    .insert(macWatch)
    .values({ heardAt: new Date(), state: { ...idle, finished } })
    .run();
  await app.s.worker.work();
  expect(uploads()).toHaveLength(0);
  expect(getJob(env.db, jobId)?.state).toBe("queued");
  env.db.update(macWatch).set({ state: idle }).run();
  await app.s.worker.work();
  expect(uploads()).toHaveLength(1);
});

test("a block's words group its source at once", async () => {
  const app = appWith();
  const iso = (ms: number) => new Date(ms).toISOString();
  // The phone heard 5 minutes, no speech labelled: only the words make a conversation.
  const timeline = await app.request(`/sources/${SOURCE}/timeline`, {
    body: JSON.stringify({
      heardThrough: iso(T0 + 120_000),
      spans: [
        {
          audible: [[iso(T0), iso(T0 + 300_000)]],
          breaks: [],
          endAt: iso(T0 + 300_000),
          firstPage: 1,
          pauses: [],
          speech: [],
          startAt: iso(T0),
          unanalyzed: [],
        },
      ],
    }),
    headers: { ...auth, "Content-Type": "application/json" },
    method: "PUT",
  });
  expect(timeline.status).toBe(200);
  expect(countRows(env.db, conversations)).toBe(0);
  const jobId = await admitFragment(app, audio(60), 1);
  await app.s.worker.work();
  await completeByWebhook(app, jobRow(jobId));
  const [conversation] = env.db.select().from(conversations).all();
  expect(conversation?.captureStartedAt.getTime()).toBe(T0);
});

test("a span placed again more than 1 s off under a job's pages is logged, its map left", async () => {
  const app = appWith();
  const jobId = await admitFragment(app, audio(60), 1);
  const put = (firstPage: number, at: number) =>
    app.request(`/sources/${SOURCE}/timeline`, {
      body: JSON.stringify({
        heardThrough: null,
        spans: [
          {
            audible: [],
            breaks: [],
            endAt: new Date(at + 60_000).toISOString(),
            firstPage,
            pauses: [],
            speech: [],
            startAt: new Date(at).toISOString(),
            unanalyzed: [],
          },
        ],
      }),
      headers: { ...auth, "Content-Type": "application/json" },
      method: "PUT",
    });
  // Page 1 is the job's, page 50 nobody's; 1 s off is within the clock's play.
  for (const [page, at] of [
    [1, T0],
    [50, T0],
    [1, T0 + 1000],
    [1, T0 + 6000],
    [50, T0 + 9000],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: in order
    expect((await put(page, at)).status).toBe(200);
  }
  const logged = env.db
    .select({ fields: events.fields })
    .from(events)
    .where(eq(events.name, "job.span_moved"))
    .all();
  expect(logged.map((e) => e.fields)).toEqual([{ jobId, ms: 5000 }]);
  expect(jobRow(jobId).map?.segments).toEqual([[T0, T0 + 60_000]]);
});

test("the worker keeps at most ELEVENLABS_SLOTS jobs at ElevenLabs; a finished one makes room", async () => {
  const app = appWith({ ELEVENLABS_SLOTS: "2" });
  const ids: string[] = [];
  for (const page of [0, 100, 200]) {
    // biome-ignore lint/performance/noAwaitInLoops: in order
    ids.push(await admitFragment(app, audio(60), page));
  }
  await Promise.all([app.s.worker.work(), app.s.worker.work()]);
  expect(uploads()).toHaveLength(2);
  expect(jobRow(ids[2] ?? "").state).toBe("queued");

  // The webhook frees a slot and starts the worker.
  await completeByWebhook(app, jobRow(ids[0] ?? ""));
  await app.s.worker.work();
  expect(uploads()).toHaveLength(3);
  expect(jobRow(ids[2] ?? "").state).toBe("submitted");
});

test("429: the job stays queued, not an attempt, and goes once its next attempt is due", async () => {
  const app = appWith();
  fake.respond = () => new Response("busy", { status: 429 });
  const jobId = await admitFragment(app, audio(60), 1);
  await app.s.worker.work();
  const waiting = jobRow(jobId);
  expect(waiting).toMatchObject({
    attempts: 0,
    requestSentAt: null,
    state: "queued",
  });
  expect(waiting.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now());
  await app.s.worker.work();
  expect(uploads()).toHaveLength(1);

  fake.respond = accept;
  due(jobId);
  await app.s.worker.work();
  expect(jobRow(jobId).state).toBe("submitted");
  expect(uploads()).toHaveLength(2);
});

test("transcription off or credits used up: nothing is sent; jobs wait queued", async () => {
  const app = appWith();
  const config = testConfig(baseUrl);
  let used = 49_217;
  fake.respond = (call) =>
    call.path.endsWith("/v1/user/subscription")
      ? Response.json({ character_count: used, character_limit: 49_217 })
      : accept();
  setSwitches(env.db, { transcription: false });
  const jobId = await admitFragment(app, audio(60), 1);
  await app.s.worker.work();
  expect(uploads()).toHaveLength(0);
  setSwitches(env.db, { transcription: true });

  const worker = jobWorker(env.db, config, app.audio);
  await worker.checkCredits();
  await worker.work();
  expect(uploads()).toHaveLength(0);
  expect(jobRow(jobId).state).toBe("queued");

  used = 1000;
  await worker.tick();
  expect(uploads()).toHaveLength(1);
});

test("credits: one email under 20 % and one when out, at most once per 12 h each", async () => {
  const config = testConfig(baseUrl);
  let used = 0;
  fake.respond = () =>
    Response.json({ character_count: used, character_limit: 1000 });
  let clock = Date.parse("2026-10-14T00:00:00Z");
  const worker = jobWorker(
    env.db,
    config,
    memoryAudioStore(),
    macSocket(env.db),
    () => clock
  );
  const alerts = () =>
    env.db
      .all<{ level: string }>(
        sql`select fields ->> '$.level' as level from events where name = 'elevenlabs.quota_alert' order by at`
      )
      .map((r) => r.level);
  const read = async (n: number) => {
    used = n;
    clock += 60_000;
    await worker.checkCredits();
  };

  await read(500);
  await read(850);
  await read(900);
  expect(alerts()).toEqual(["low"]);
  await read(1000);
  expect(alerts()).toEqual(["low", "out"]);
  // Renewed, then low again within 12 h: no second email.
  await read(0);
  await read(850);
  expect(alerts()).toEqual(["low", "out"]);
  clock += 12 * 3600 * 1000;
  await read(0);
  await read(850);
  expect(alerts()).toEqual(["low", "out", "low"]);
});

test("lost: a job ElevenLabs doesn't know 30 min after it was sent goes again, from the bucket", async () => {
  const app = appWith();
  const a = audio(60);
  const jobId = await admitFragment(app, a, 1);
  await app.s.worker.work();
  const recent = await admitFragment(app, audio(60), 100);
  await app.s.worker.work();
  env.db.run(
    sql`update transcription_jobs set request_sent_at = ${Date.now() - 3_600_000} where id = ${jobId}`
  );
  fake.respond = () => new Response("not found", { status: 404 });
  const settled = await app.s.worker.tick();
  expect(settled).toEqual({ checked: 2, completed: 0, failed: 0, retried: 1 });
  expect(settled).toMatchObject({ failed: 0 });
  expect(jobRow(jobId)).toMatchObject({
    attempts: 1,
    maybeBilled: false,
    providerRequestId: null,
    providerTranscriptionId: null,
    state: "queued",
  });
  expect(jobRow(recent).state).toBe("submitted");

  fake.respond = accept;
  due(jobId);
  await app.s.worker.work();
  expect(jobRow(jobId).state).toBe("submitted");
  expect(await sentAudio()).toEqual(a.data);
});

test("a stale reconcile moves nothing: the job went again while it fetched", async () => {
  const app = appWith();
  const jobId = await admitFragment(app, audio(60), 1);
  await app.s.worker.work();
  env.db.run(
    sql`update transcription_jobs set request_sent_at = ${Date.now() - 3_600_000} where id = ${jobId}`
  );
  // While this reconcile asks, a webhook settled it and the worker sent it again.
  fake.respond = (call) => {
    if (call.path.includes("/transcripts/")) {
      env.db.run(
        sql`update transcription_jobs set request_sent_at = ${Date.now()} where id = ${jobId}`
      );
      return new Response("not found", { status: 404 });
    }
    return accept();
  };
  expect(await app.s.worker.tick()).toMatchObject({ retried: 0 });
  expect(jobRow(jobId)).toMatchObject({
    attempts: 0,
    state: "submitted",
  });
});

test("reconcile fetches a submitted job by its transcription id; one cut off mid-send waits for its webhook, then fails, never sent again", async () => {
  const app = appWith();
  const done = await admitFragment(app, audio(60), 1);
  const severed = await admitFragment(app, audio(60), 100);
  await app.s.worker.work();
  const cutOff = (agoMs: number) =>
    env.db.run(
      sql`update transcription_jobs set provider_request_id = null, provider_transcription_id = null, request_sent_at = ${Date.now() - agoMs} where id = ${severed}`
    );
  cutOff(2 * 3_600_000);
  const { providerTranscriptionId } = jobRow(done);
  fake.respond = (call) =>
    call.path.endsWith(providerTranscriptionId ?? "")
      ? Response.json(providerTranscript)
      : accept();
  expect(await app.s.worker.tick()).toEqual({
    checked: 2,
    completed: 1,
    failed: 0,
    retried: 0,
  });
  expect(jobRow(done)).toMatchObject({ state: "completed" });
  expect(jobRow(done).completedAt).not.toBeNull();
  expect(jobRow(severed).state).toBe("submitted");

  cutOff(25 * 3_600_000);
  expect(await app.s.worker.tick()).toMatchObject({ failed: 1 });
  expect(jobRow(severed)).toMatchObject({
    attempts: 0,
    maybeBilled: true,
    state: "failed",
  });
  expect(uploads()).toHaveLength(2);
  // Its webhook after all: the transcript was bought, so it is kept.
  expect(await (await completeByWebhook(app, jobRow(severed))).json()).toEqual({
    result: "applied",
  });
  expect(jobRow(severed).state).toBe("completed");
});

test("a refusal fails the job at once; a 5xx may be billed: it waits for its webhook, never sent again", async () => {
  const app = appWith();
  fake.respond = () => new Response('{"detail":"bad"}', { status: 422 });
  const jobId = await admitFragment(app, audio(60), 1);
  await app.s.worker.work();
  due(jobId);
  await app.s.worker.work();
  expect(jobRow(jobId)).toMatchObject({ attempts: 0, state: "failed" });
  expect(uploads()).toHaveLength(1);
  // Its pages stay with it: a fragment on them is refused, never bought.
  expect(await keep(app, audio(60), 5)).toBe("held");

  fake.respond = () => new Response("upstream", { status: 503 });
  const maybe = await admitFragment(app, audio(60), 100);
  await app.s.worker.work();
  await app.s.worker.tick();
  expect(jobRow(maybe)).toMatchObject({
    attempts: 0,
    maybeBilled: true,
    state: "submitted",
  });
  expect(uploads()).toHaveLength(2);
  // Its failure webhook: it may have been billed, so it fails, never sent again.
  await deliver(app, {
    data: {
      error: "failed after all",
      webhook_metadata: JSON.stringify({ attempt: 0, jobId: maybe }),
    },
    type: "speech_to_text_transcription",
  });
  expect(jobRow(maybe)).toMatchObject({ state: "failed" });

  // Audio gone from the bucket fails its job.
  fake.respond = accept;
  const lost = await admitFragment(app, audio(60), 200);
  app.audio.objects.clear();
  await app.s.worker.work();
  expect(jobRow(lost)).toMatchObject({
    error: "its audio is not in the bucket",
    state: "failed",
  });
});

test("a refused connection never left: queued again, not an attempt, not maybe billed", async () => {
  const audioStore = memoryAudioStore();
  const s = services(testConfig("http://127.0.0.1:1"), env.db, {
    audio: audioStore,
  });
  const app = Object.assign(createApp(s), { audio: audioStore, s });
  const jobId = await admitFragment(app, audio(60), 1);
  await s.worker.work();
  const job = jobRow(jobId);
  expect(job).toMatchObject({
    attempts: 0,
    maybeBilled: false,
    state: "queued",
  });
  expect(job.error).toContain("ConnectionRefused");
});

test("webhooks: a reported failure is an attempt, with null fields too; an unreadable one is kept for reconcile", async () => {
  const app = appWith();
  const reported = await admitFragment(app, audio(60), 1);
  const garbled = await admitFragment(app, audio(60), 100);
  await app.s.worker.work();

  // Oct 13–14: ~650-byte failure webhooks with null fields were ignored unseen.
  const failed = await deliver(app, {
    data: {
      error: { message: "audio could not be decoded" },
      request_id: null,
      status: null,
      transcription: null,
      webhook_metadata: JSON.stringify({ jobId: reported }),
    },
    type: "speech_to_text_transcription",
  });
  expect(await failed.json()).toEqual({ result: "retried" });
  expect(jobRow(reported)).toMatchObject({
    attempts: 1,
    error: "refused by the provider: audio could not be decoded",
    state: "queued",
  });
  // Sent again; a late failure of the first send changes nothing.
  due(reported);
  await app.s.worker.work();
  const late = await deliver(app, {
    data: {
      error: "late",
      webhook_metadata: JSON.stringify({ attempt: 0, jobId: reported }),
    },
    type: "speech_to_text_transcription",
  });
  expect(await late.json()).toEqual({ result: "stale" });
  expect(jobRow(reported).state).toBe("submitted");
  // The third failure fails it, its pages kept: a failure that repeats never loops.
  const failure = (attempt: number) =>
    deliver(app, {
      data: {
        error: "again",
        webhook_metadata: JSON.stringify({ attempt, jobId: reported }),
      },
      type: "speech_to_text_transcription",
    });
  await failure(1);
  expect(jobRow(reported)).toMatchObject({
    attempts: 2,
    state: "queued",
  });
  due(reported);
  await app.s.worker.work();
  expect(await (await failure(2)).json()).toEqual({ result: "failed" });
  expect(jobRow(reported)).toMatchObject({
    attempts: 3,
    pages: [[1, 10]],
    state: "failed",
  });
  expect(uploads()).toHaveLength(4);

  const { providerRequestId } = jobRow(garbled);
  const unreadable = await deliver(app, {
    data: {
      request_id: providerRequestId,
      transcription: { nonsense: true },
    },
    type: "speech_to_text_transcription",
  });
  expect(await unreadable.json()).toEqual({ result: "kept" });
  expect(jobRow(garbled).state).toBe("submitted");
});

test("the Mac's watermark cases", async () => {
  const { cases } = await Bun.file(
    `${import.meta.dir}/../fixtures/mac-vouches.json`
  ).json();
  for (const c of cases) {
    expect([
      c.why,
      new Date(c.end) <= vouchedThrough(c.watch, new Date(c.now)),
    ]).toEqual([c.why, c.vouches]);
  }
});

// Polls a condition the Mac's socket reaches asynchronously.
const until = async (ok: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: polling
    if (await ok()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("never happened");
};

test("dictation the Mac hasn't reported yet reaches the bucket, never ElevenLabs: its range withdraws the job, and the Mac's word sends the rest", async () => {
  const MAC_TOKEN = "mac-test-token";
  const app = appWith({ MAC_TOKEN_HASH: sha256Hex(MAC_TOKEN) });
  const server = Bun.serve({
    fetch: app.fetch,
    port: 0,
    websocket: app.s.mac.websocket,
  });
  try {
    // The owner dictated 21 s into the first minute, and the Mac was heard before that dictation
    // was a range: the watermark holds at its padded start.
    const finished = { end: T0 + 29_000, source: "claude", start: T0 + 21_000 };
    env.db
      .insert(macWatch)
      .values({ heardAt: new Date(), state: { ...idle, finished } })
      .run();

    // Two jobs made past the watermark (as if a range came after their blocks closed) wait in the
    // bucket: the worker's gate holds them.
    const dictated = await admitFragment(app, audio(60), 1);
    const clean = await admitFragment(app, audio(60), 11);
    await app.s.worker.work();
    expect(uploads()).toHaveLength(0);
    expect(app.audio.objects.size).toBe(2);

    // The Mac's word: its rules store the range, which frees the watermark and runs the worker
    // by itself.
    // Bun's client takes headers; the DOM typing it is merged with doesn't say so.
    const BunSocket = WebSocket as unknown as new (
      url: string,
      options: Bun.WebSocketOptions
    ) => WebSocket;
    const ws = new BunSocket(
      `ws://localhost:${server.port}/quiet-ranges/socket?protocol=2`,
      { headers: { Authorization: `Bearer ${MAC_TOKEN}` } }
    );
    await new Promise((resolve) => {
      ws.onopen = resolve;
    });
    ws.send(JSON.stringify({ engines: ["claude"], type: "hello" }));
    await until(() => countRows(env.db, quietRanges) === 1);
    await until(() => uploads().length === 1);
    await until(() => getJob(env.db, dictated) === undefined);
    expect(jobRow(clean).state).toBe("submitted");
    expect(uploads()).toHaveLength(1);
    expect(app.audio.objects.size).toBe(1);

    // The feed brings the range, then says the job went from page 1: the phone sends those pages
    // again without it.
    const feed = await (
      await app.request("/changes?since=0", { headers: auth })
    ).json();
    expect(feed.quietRanges).toHaveLength(1);
    const removed = { firstPage: 1, kind: "job", sourceId: SOURCE };
    expect(feed.removed).toContainEqual({ ...removed, ref: dictated });
    ws.close();
    await until(() => app.s.mac.live() === null);
  } finally {
    await server.stop(true);
  }
});

test("handed over: old parts' pages and bought audio are never bought again", async () => {
  const app = appWith();
  const [old] = env.db
    .insert(transcriptionJobs)
    .values({
      audioSha256: "old",
      billableSeconds: 1,
      // Bought before the handover (instants are milliseconds: not the same one).
      createdAt: new Date(Date.now() - 60_000),
      preparedDurationSeconds: 1,
      settings: { keyterms: [], languageCode: null, numSpeakers: null },
      settingsHash: "h",
      state: "completed",
    })
    .returning()
    .all();
  const blocks = async () =>
    (await app.request(`/sources/${SOURCE}/blocks`, { headers: auth })).json();
  expect((await blocks()).handedOver).toBe(false);
  // As the cutover left it: the old part holds its pages and the source is handed over.
  env.db
    .insert(sources)
    .values({ handedOverAt: new Date(), id: SOURCE })
    .onConflictDoUpdate({
      set: { handedOverAt: new Date() },
      target: sources.id,
    })
    .run();
  env.db
    .update(transcriptionJobs)
    .set({ pages: [[0, 9]], sourceId: SOURCE })
    .where(eq(transcriptionJobs.id, old?.id ?? ""))
    .run();
  expect(await blocks()).toEqual({
    blocks: [{ jobId: old?.id, pages: [[0, 9]] }],
    handedOver: true,
    sentThrough: null,
  });
  // The phone's last word: a new install starts its cursor at the page holding it.
  const sent = new Date("2026-10-23T10:56:37.615Z");
  env.db
    .update(sources)
    .set({ sentThrough: sent })
    .where(eq(sources.id, SOURCE))
    .run();
  expect((await blocks()).sentThrough).toBe(sent.toISOString());

  // A fragment on an old part's pages is refused: nothing is bought twice.
  expect(await keep(app, audio(60), 0)).toBe("held");
  // Old audio on other pages that the old job bought (it kept no pages, or lost them to another
  // job): bought, so the cutter covers it.
  env.db
    .update(transcriptionJobs)
    .set({
      captureEnd: new Date(T0 + 1_300_000),
      captureStart: new Date(T0 + 1_150_000),
      map: { segments: [[T0 + 1_150_000, T0 + 1_300_000]], separatorMs: 400 },
    })
    .where(eq(transcriptionJobs.id, old?.id ?? ""))
    .run();
  const at = (from: number) => ({
    segments: [[from, from + 60_000]] as [number, number][],
    separatorMs: 400,
  });
  expect(bought(env.db, at(T0 + 1_200_000), SOURCE)).toBe(true);
  const later = Date.now() - 5 * 60_000;
  await admitFragment(app, audio(60), 60, at(later).segments);
  await app.s.worker.work();
  expect(uploads()).toHaveLength(1);
  // Since the handover the source's own jobs are their pages: a sent job's map placed by an older
  // clock model (it overlaps here by 30 s) covers nothing on other pages.
  expect(bought(env.db, at(later + 30_000), SOURCE)).toBe(false);
});

test("the phone is asked for its blocks while the Pendant records and heard-through lags 5 minutes", async () => {
  const asked: unknown[] = [];
  const nudge = (ready: string, fields?: unknown) => {
    asked.push({ ready, ...(fields as object) });
    return Promise.resolve();
  };
  const now = new Date(T0);
  let beats = 0;
  const heartbeat = (state: string, lastKnown?: string) => {
    beats += 1;
    return env.db
      .insert(heartbeats)
      .values({
        body: { recording: { lastKnown, state } },
        id: randomUUID(),
        // Each one later than the last: the latest is read by its time.
        observedAt: new Date(T0 + beats),
        reason: "periodic",
        receivedAt: new Date(),
      })
      .run();
  };
  // Before the handover there is no heard-through: nothing to ask.
  heartbeat("recording");
  expect(await askForUploads(env.db, nudge, now)).toBe(false);
  env.db
    .insert(sources)
    .values({
      heardThrough: new Date(T0 - 4 * 60_000),
      id: SOURCE,
    })
    .run();
  expect(await askForUploads(env.db, nudge, now)).toBe(false);
  env.db
    .update(sources)
    .set({ heardThrough: new Date(T0 - 6 * 60_000) })
    .run();
  expect(await askForUploads(env.db, nudge, now)).toBe(true);
  expect(asked).toEqual([{ behindSeconds: 360, ready: "upload" }]);
  // The link lost: the Pendant still records to its flash, by its last confirmed state.
  heartbeat("unknown", "recording");
  expect(await askForUploads(env.db, nudge, now)).toBe(true);
  // The last confirmed state wins over the current one.
  heartbeat("recording", "not_recording");
  expect(await askForUploads(env.db, nudge, now)).toBe(false);
  // The Pendant paused: the phone has nothing to send.
  heartbeat("paused", "not_recording");
  expect(await askForUploads(env.db, nudge, now)).toBe(false);
  expect(asked).toHaveLength(2);
});

test("the owner is asked to open the app once per episode, at his delay", async () => {
  const alerts: unknown[] = [];
  const nudge = phoneNudger(
    env.db,
    (request) => {
      if (request.headers["apns-push-type"] === "alert") {
        alerts.push(JSON.parse(request.body).aps.alert);
      }
      return Promise.resolve({ body: "", status: 200 });
    },
    "bundle"
  );
  storePushToken(env.db, "ab".repeat(80));
  env.db
    .insert(heartbeats)
    .values({
      body: { recording: { state: "recording" } },
      id: randomUUID(),
      observedAt: new Date(),
      reason: "periodic",
      receivedAt: new Date(),
    })
    .run();
  // A tick `at` minutes in, with the Pendant heard through `heard` minutes in; returns the alerts so far.
  const tick = async (at: number, heard: number, delay = 15) => {
    setSwitches(env.db, { openAppAfterMinutes: delay });
    env.db
      .insert(sources)
      .values({ heardThrough: new Date(T0 + heard * 60_000), id: SOURCE })
      .onConflictDoUpdate({
        set: { heardThrough: new Date(T0 + heard * 60_000) },
        target: sources.id,
      })
      .run();
    await askForUploads(env.db, nudge, new Date(T0 + at * 60_000));
    return alerts.length;
  };
  expect(await tick(0, -14)).toBe(0);
  expect(await tick(0, -16)).toBe(1);
  expect(alerts[0]).toEqual({
    body: "Your Pendant has 16 minutes waiting to sync.",
    title: "Open lifelog",
  });
  // Still behind at the next ticks: the same episode.
  expect(await tick(5, -16)).toBe(1);
  expect(await tick(10, -16)).toBe(1);
  // Caught up, then behind again: a new episode.
  expect(await tick(30, 25)).toBe(1);
  expect(await tick(42, 25)).toBe(2);
  // Off: never.
  expect(await tick(200, 25, 0)).toBe(2);
  // Not recording: nothing.
  env.db
    .insert(heartbeats)
    .values({
      body: { recording: { state: "paused" } },
      id: randomUUID(),
      observedAt: new Date(),
      reason: "periodic",
      receivedAt: new Date(),
    })
    .run();
  expect(await tick(400, 25)).toBe(2);
  setSwitches(env.db, { openAppAfterMinutes: 15 });
});

test("latency: median and 90th percentile from speech end to upload to words", async () => {
  const app = appWith();
  const jobId = await admitFragment(app, audio(60), 1);
  await app.s.worker.work();
  await completeByWebhook(app, jobRow(jobId));
  env.db.run(
    sql`update transcription_jobs set capture_end = created_at - 120000, completed_at = created_at + 40000`
  );
  expect(latency(env.db, new Date(Date.now() - 60_000))).toEqual({
    jobs: 1,
    transcriptionSeconds: { median: 40, p90: 40 },
    uploadSeconds: { median: 120, p90: 120 },
  });
  // Interpolated as Postgres' percentile_cont, rounded.
  expect(spread([1, 2, 3, 4])).toEqual({ median: 3, p90: 4 });
  expect(spread([0, 10])).toEqual({ median: 5, p90: 9 });
  expect(spread([])).toEqual({ median: null, p90: null });
});

test("audio the provider can't read is a gap: no words, not billed, never sent again", async () => {
  const app = appWith();
  fake.respond = () =>
    new Response(
      '{"detail":{"type":"validation_error","code":"invalid_audio","message":"File is corrupted"}}',
      { status: 400 }
    );
  const corrupt = audio(60);
  const jobId = await admitFragment(app, corrupt, 1);
  await app.s.worker.work();
  const job = jobRow(jobId);
  expect(job.state).toBe("completed");
  expect(job.error).toContain("invalid_audio");
  expect(job.billableSeconds).toBe(0);
  const transcript = await (
    await app.request(`/transcription-jobs/${job.id}/transcript`, {
      headers: auth,
    })
  ).json();
  expect(transcript.words).toEqual([]);
  expect(await admitFragment(app, corrupt, 1)).toBe(job.id);
  await app.s.worker.work();
  expect(uploads()).toHaveLength(1);
});

test("a transcript that completes on a block gets its turns in capture time at once", async () => {
  const app = appWith();
  const jobId = await admitFragment(app, audio(120), 1);
  await app.s.worker.work();
  expect(countRows(env.db, turns)).toBe(0);
  expect((await completeByWebhook(app, jobRow(jobId))).status).toBe(200);
  const rows = env.db.select().from(turns).orderBy(turns.turnIndex).all();
  expect(
    rows.map((r) => [r.speakerLabel, r.text, r.startAt.getTime()])
  ).toEqual([
    ["speaker_0", "Hello there.", T0],
    ["speaker_1", "Bonjour!", T0 + 1500],
  ]);
});

test("without a webhook, a send waits for its transcript, and the webhook route opens for no one", async () => {
  const app = appWith({ ELEVENLABS_WEBHOOK_SECRET: undefined });
  fake.respond = () => Response.json(providerTranscript);
  const jobId = await admitFragment(app, audio(120), 1);
  await app.s.worker.work();
  expect(uploads().at(-1)?.form?.get("webhook")).toBeNull();
  expect(jobRow(jobId).state).toBe("completed");
  expect(countRows(env.db, turns)).toBe(2);
  const body = JSON.stringify({ type: "speech_to_text_transcription" });
  const res = await app.request("/webhooks/elevenlabs", {
    body,
    headers: { "ElevenLabs-Signature": signature(body) },
    method: "POST",
  });
  expect(res.status).toBe(401);

  // A 5xx may have been billed: it waits, never sent again, though no webhook will come.
  fake.respond = () => new Response("upstream", { status: 503 });
  const maybe = await admitFragment(app, audio(60), 100);
  await app.s.worker.work();
  await app.s.worker.tick();
  expect(jobRow(maybe)).toMatchObject({
    maybeBilled: true,
    state: "submitted",
  });
  expect(uploads()).toHaveLength(2);
});

test("a webhook naming no job is recorded by its type and field names, never its content", async () => {
  const app = appWith();
  const answer = await deliver(app, {
    data: { secret: "words" },
    type: "voice_changed",
  });
  expect(await answer.json()).toEqual({ result: "ignored" });
  const [event] = env.db.all<{ fields: string }>(
    sql`select fields from events where name = 'elevenlabs.webhook' order by at desc limit 1`
  );
  expect(JSON.parse(event?.fields ?? "null")).toMatchObject({
    dataFields: "secret",
    result: "ignored",
    type: "voice_changed",
  });
  expect(JSON.stringify(event)).not.toContain("words");
});

test("webhook: verified, stored once, replay is a no-op, bad or stale signature rejected", async () => {
  const app = appWith();
  const jobId = await admitFragment(app, audio(), 1);
  await app.s.worker.work();
  const job = jobRow(jobId);
  const body = JSON.stringify({
    data: {
      request_id: job.providerRequestId,
      transcription: providerTranscript,
      webhook_metadata: JSON.stringify({ jobId: job.id }),
    },
    event_timestamp: 1,
    type: "speech_to_text_transcription",
  });
  const send = (sig: string) =>
    app.request("/webhooks/elevenlabs", {
      body,
      headers: { "ElevenLabs-Signature": sig },
      method: "POST",
    });

  expect((await send("t=1,v0=00")).status).toBe(401);
  const stale = Math.floor(Date.now() / 1000) - 31 * 60;
  expect((await send(signature(body, stale))).status).toBe(401);

  expect(await (await send(signature(body))).json()).toEqual({
    result: "applied",
  });
  expect(await (await send(signature(body))).json()).toEqual({
    result: "duplicate",
  });

  const transcript = await (
    await app.request(`/transcription-jobs/${job.id}/transcript`, {
      headers: auth,
    })
  ).json();
  expect(transcript.turns).toHaveLength(2);
  expect(countRows(env.db, transcripts)).toBe(1);
});

test("a parser bump gives stored words their spacing from raw and leaves turns alone", () => {
  // Stored before the pause split: one turn where today's parser would make two.
  const spoken = [
    { end: 5.5, speakerId: "speaker_0", start: 0, text: "One two three" },
  ];
  const jobId = seedTranscript(env.db, spoken);
  env.db
    .update(transcripts)
    .set({ parserVersion: PARSER_VERSION - 1, raw: providerTranscript })
    .where(sql`job_id = ${jobId}`)
    .run();
  rebuildTurns(env.db, jobId);
  const row = env.db.query.transcripts
    .findFirst({
      where: (t, { eq: is }) => is(t.jobId, jobId),
    })
    .sync();
  expect(row?.parserVersion).toBe(PARSER_VERSION);
  expect(row?.parsed.turns).toEqual(spoken);
  expect(row?.parsed.words.map((w) => [w.spacing, w.text])).toEqual([
    ["", "Hello"],
    [" ", "there."],
    [" ", "Bonjour!"],
  ]);
});

// Real Opus packets, so a cut can be made of them: 20 ms each (TOC 8), marked by their index and
// the file's `mark`.
function speechAudio(seconds: number, mark = 0) {
  const packets = Array.from(
    { length: seconds * 50 },
    (_, i) => new Uint8Array([8, i % 256, Math.floor(i / 256), mark])
  );
  const data = pendantOggOpus(packets, seconds * 1000);
  return { data, seconds, sha: sha256Hex(data) };
}
const turn = (
  start: number,
  end: number,
  speaker: string,
  language: string | null
) => ({ end, language, speaker, start });
const said = (start: number, text: string) => ({
  end: start + 0.3,
  start,
  text,
});
const thaiAnswer = () =>
  Response.json({
    language_code: "tha",
    language_probability: 0.9,
    words: [
      {
        end: 0.8,
        speaker_id: "speaker_0",
        start: 0.5,
        text: "สวัสดี",
        type: "word",
      },
    ],
  });

test("the speech service: English and French stay with it, other turns go to Scribe cut from the block, once", async () => {
  const app = appWith(withSpeech);
  setSwitches(env.db, { transcriber: "speech" });
  speech.heard = {
    durationSeconds: 30,
    models: {},
    turns: [
      turn(0, 10, "0", "en"),
      turn(10, 14, "1", "th"),
      turn(14, 30, "0", "fr"),
    ],
    words: [said(1, "Hello"), said(11, "noise"), said(15, "Salut")],
  };
  fake.respond = thaiAnswer;
  const jobId = await admitFragment(app, speechAudio(30), 1);
  await app.s.worker.work();

  expect(speech.blocks).toBe(1);
  expect(uploads()).toHaveLength(1);
  const form = uploads()[0]?.form;
  expect(form?.get("diarize")).toBe("false");
  expect(form?.get("webhook")).toBeNull();
  const job = jobRow(jobId);
  expect(job).toMatchObject({
    billableSeconds: 4.5,
    maybeBilled: false,
    state: "completed",
    transcriber: "speech",
  });
  const stored = env.db
    .select()
    .from(transcripts)
    .where(eq(transcripts.jobId, jobId))
    .get();
  // The cut starts with the first packet in [9.75, 14.25), at 9.76 s: Scribe's word at 0.5 s of it
  // is 10.26 s into the block, in the Thai turn.
  expect(
    stored?.parsed.words.map((w) => [w.text, w.start, w.speakerId])
  ).toEqual([
    ["Hello", 1, "speaker_0"],
    ["สวัสดี", 10.26, "speaker_1"],
    ["Salut", 15, "speaker_0"],
  ]);
  await app.s.worker.work();
  expect(uploads()).toHaveLength(1);
});

test("the speech service, credits used up: English and French still complete on the Mac", async () => {
  const app = appWith(withSpeech);
  setSwitches(env.db, { transcriber: "speech" });
  fake.respond = () =>
    Response.json({ character_count: 1000, character_limit: 1000 });
  await app.s.worker.checkCredits();
  speech.heard = {
    durationSeconds: 30,
    models: {},
    turns: [turn(0, 10, "0", "en"), turn(10, 30, "1", "fr")],
    words: [said(1, "Hello"), said(15, "Salut")],
  };
  const jobId = await admitFragment(app, speechAudio(30), 1);
  await app.s.worker.work();
  expect(uploads()).toHaveLength(0);
  expect(jobRow(jobId)).toMatchObject({
    state: "completed",
    transcriber: "speech",
  });
  // Nothing waits for the credits, so no conversation says it does.
  expect(app.s.worker.creditsOut()).toBe(false);
});

test("the speech service, credits used up: a block with Thai turns waits for them, and goes when they are back", async () => {
  const app = appWith(withSpeech);
  setSwitches(env.db, { transcriber: "speech" });
  let used = 1000;
  fake.respond = (call) =>
    call.path.endsWith("/v1/user/subscription")
      ? Response.json({ character_count: used, character_limit: 1000 })
      : thaiAnswer();
  await app.s.worker.checkCredits();
  speech.heard = {
    durationSeconds: 30,
    models: {},
    turns: [
      turn(0, 10, "0", "en"),
      turn(10, 14, "1", "th"),
      turn(14, 30, "0", "fr"),
    ],
    words: [said(1, "Hello"), said(15, "Salut")],
  };
  const jobId = await admitFragment(app, speechAudio(30), 1);
  await app.s.worker.work();
  expect(uploads()).toHaveLength(0);
  const held = jobRow(jobId);
  expect(held).toMatchObject({ maybeBilled: false, state: "queued" });
  expect(held.error).toContain("credits");
  await app.s.worker.work();
  expect(speech.blocks).toBe(1);
  // Not every conversation: only the one with this block says it waits for credits.
  expect(app.s.worker.creditsOut()).toBe(false);

  used = 100;
  await app.s.worker.tick();
  expect(uploads()).toHaveLength(1);
  // Released, it is heard again on the Mac before its turns go.
  expect(speech.blocks).toBe(2);
  expect(jobRow(jobId)).toMatchObject({ state: "completed" });
});

test("credits used up, the 24 Oct migration makes the blocks waiting for them due once: one the routing now keeps local completes on the Mac", async () => {
  const app = appWith(withSpeech);
  setSwitches(env.db, { transcriber: "speech" });
  fake.respond = (call) =>
    call.path.endsWith("/v1/user/subscription")
      ? Response.json({ character_count: 1000, character_limit: 1000 })
      : thaiAnswer();
  await app.s.worker.checkCredits();
  speech.heard = {
    durationSeconds: 30,
    models: {},
    turns: [turn(0, 10, "0", "en"), turn(10, 14, "1", "th")],
    words: [said(1, "Hello")],
  };
  const jobId = await admitFragment(app, speechAudio(30), 1);
  await app.s.worker.work();
  expect(jobRow(jobId).state).toBe("queued");
  await app.s.worker.work();
  expect(speech.blocks).toBe(1);
  // The migration, as the server runs it at its next start; heard again as French, the block completes.
  env.db.run(
    sql.raw(
      await Bun.file(
        join(MIGRATIONS, "20261024140119_rehear_credit_waits.sql")
      ).text()
    )
  );
  speech.heard = {
    durationSeconds: 30,
    models: {},
    turns: [turn(0, 10, "0", "en"), turn(10, 14, "1", "fr")],
    words: [said(1, "Hello"), said(11, "Salut")],
  };
  await app.s.worker.work();
  expect(speech.blocks).toBe(2);
  expect(uploads()).toHaveLength(0);
  expect(jobRow(jobId)).toMatchObject({
    state: "completed",
    transcriber: "speech",
  });
});

test("the speech service: a block 70% routed goes to Scribe whole, as a Scribe job; busy, it waits", async () => {
  const app = appWith(withSpeech);
  setSwitches(env.db, { transcriber: "speech" });
  speech.busy = true;
  const jobId = await admitFragment(app, speechAudio(10), 1);
  await app.s.worker.work();
  expect(jobRow(jobId)).toMatchObject({
    attempts: 0,
    requestSentAt: null,
    state: "queued",
  });
  expect(uploads()).toHaveLength(0);

  speech.busy = false;
  speech.heard = {
    durationSeconds: 10,
    models: {},
    turns: [turn(0, 2, "0", "en"), turn(2, 10, "1", "th")],
    words: [said(1, "Hi")],
  };
  due(jobId);
  await app.s.worker.work();
  expect(uploads()).toHaveLength(1);
  expect(uploads()[0]?.form?.get("diarize")).toBe("true");
  expect(jobRow(jobId)).toMatchObject({
    state: "submitted",
    transcriber: "scribe",
  });
});

test("the speech service: one cut off by a restart goes again, unless Scribe may have billed its turns", async () => {
  const app = appWith(withSpeech);
  const fresh = await admitFragment(app, speechAudio(10), 1);
  const billed = await admitFragment(app, speechAudio(10, 1), 100);
  const sent = Date.now() - 11 * 60_000;
  env.db
    .update(transcriptionJobs)
    .set({
      requestSentAt: new Date(sent),
      state: "submitted",
      transcriber: "speech",
    })
    .run();
  env.db
    .update(transcriptionJobs)
    .set({ maybeBilled: true })
    .where(eq(transcriptionJobs.id, billed))
    .run();
  setSwitches(env.db, { transcription: false });
  await app.s.worker.tick();
  setSwitches(env.db, { transcription: true });
  expect(jobRow(fresh)).toMatchObject({ requestSentAt: null, state: "queued" });
  expect(jobRow(billed).state).toBe("failed");
  expect(uploads()).toHaveLength(0);
});

test("the speech service: a block it keeps failing goes to Scribe whole after its attempts; a moved job is never sent", async () => {
  const app = appWith(withSpeech);
  setSwitches(env.db, { transcriber: "speech" });
  speech.failing = true;
  const jobId = await admitFragment(app, speechAudio(10), 1);
  for (const attempt of [1, 2]) {
    // biome-ignore lint/performance/noAwaitInLoops: one attempt after the other
    await app.s.worker.work();
    expect(jobRow(jobId)).toMatchObject({ attempts: attempt, state: "queued" });
    due(jobId);
  }
  await app.s.worker.work();
  expect(uploads()).toHaveLength(1);
  expect(jobRow(jobId)).toMatchObject({
    attempts: 0,
    state: "submitted",
    transcriber: "scribe",
  });

  // Moved back while the service heard it: nothing is bought.
  speech.failing = false;
  speech.heard = {
    durationSeconds: 10,
    models: {},
    turns: [turn(0, 10, "0", "th")],
    words: [],
  };
  const moved = await admitFragment(app, speechAudio(10, 2), 100);
  speech.meanwhile = () => {
    speech.meanwhile = () => undefined;
    env.db
      .update(transcriptionJobs)
      .set({
        nextAttemptAt: new Date(Date.now() + 60_000),
        requestSentAt: null,
        state: "queued",
      })
      .where(eq(transcriptionJobs.id, moved))
      .run();
  };
  await app.s.worker.work();
  expect(uploads()).toHaveLength(1);
  expect(jobRow(moved)).toMatchObject({
    state: "queued",
    transcriber: "speech",
  });
});
