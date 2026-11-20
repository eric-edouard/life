// Paid sends through the job worker with one ElevenLabs slot: dictation beside the pendant's blocks,
// the POST's own clock, and slots freed by what settles them (scribe-slots.ts holds the order rules).
import { expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MIGRATIONS, migrateDb } from "@lifelog/db";
import { transcriptionJobs } from "@lifelog/db/schema";
import { eq, sql } from "drizzle-orm";
import { memoryAudioStore } from "./audio-store";
import { latestSeq } from "./change-log";
import { jobBench } from "./job-bench";
import { getJob } from "./jobs";
import { addQuietRange } from "./quiet-ranges";
import { creditsWatch } from "./scribe-credits";
import { setSwitches } from "./switches";
import { OWNER_TOKEN, providerTranscript } from "./testing";

const {
  admitFragment,
  appWith,
  audio,
  completeByWebhook,
  deliver,
  due,
  env,
  fake,
  inThaiZone,
  jobRow,
  said,
  speech,
  speechAudio,
  T0,
  thaiAnswer,
  turn,
  uploads,
  withSpeech,
} = jobBench();

const MIN = 60_000;
const oneSlot = { ...withSpeech, ELEVENLABS_SLOTS: "1" };
type App = ReturnType<typeof appWith>;

// Dictation's paid send: it holds its slot from its grant (`posted`) until `free()`.
function dictate(app: App) {
  let free: () => void = () => undefined;
  let started: () => void = () => undefined;
  const posted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const done = app.s.worker.paidSend(
    "dictation",
    { priority: "interactive", waitMs: 10 * MIN },
    () => null,
    () => {
      started();
      return new Promise<void>((end) => {
        free = end;
      });
    }
  );
  return { done, free: () => free(), posted };
}
const within = (ms: number, what: Promise<unknown>) =>
  Promise.race([what.then(() => true), Bun.sleep(ms).then(() => false)]);
async function until(holds: () => boolean) {
  for (let i = 0; i < 200 && !holds(); i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: polling a background send
    await Bun.sleep(5);
  }
  return holds();
}
const THAI = {
  durationSeconds: 30,
  models: {},
  turns: [
    turn(0, 10, "0", "en"),
    turn(10, 14, "1", "th"),
    turn(14, 30, "0", "fr"),
  ],
  words: [said(1, "Hello"), said(15, "Salut")],
};
const ALL_THAI = {
  durationSeconds: 10,
  models: {},
  turns: [turn(0, 10, "0", "th")],
  words: [],
};

test("a block at the speech service holds no slot: dictation gets it at once", async () => {
  const app = appWith(oneSlot);
  setSwitches(env.db, { transcriber: "speech" });
  speech.heard = {
    durationSeconds: 10,
    models: {},
    turns: [turn(0, 10, "0", "en")],
    words: [said(1, "Hello")],
  };
  let dictation: ReturnType<typeof dictate> | undefined;
  speech.meanwhile = () => {
    dictation = dictate(app);
  };
  const jobId = await admitFragment(app, speechAudio(10), 1);
  await app.s.worker.work();
  expect(await within(500, dictation?.posted ?? Promise.reject())).toBe(true);
  dictation?.free();
  expect(jobRow(jobId).state).toBe("completed");
});

test("dictation takes the slot next after the send under way, ahead of older work, which goes by itself once dictation is done", async () => {
  const app = appWith(oneSlot);
  setSwitches(env.db, { transcriber: "scribe" });
  const first = await admitFragment(app, audio(60), 1);
  await app.s.worker.work();
  const older = await admitFragment(app, audio(60), 100);
  const dictation = dictate(app);
  await app.s.worker.work();
  expect(jobRow(older).state).toBe("queued");

  await completeByWebhook(app, jobRow(first));
  expect(await within(500, dictation.posted)).toBe(true);
  await app.s.worker.work();
  expect(jobRow(older).state).toBe("queued");
  expect(uploads()).toHaveLength(1);

  // No call to the worker: the freed slot sends what is queued.
  dictation.free();
  expect(await until(() => uploads().length === 2)).toBe(true);
  expect(jobRow(older).state).toBe("submitted");
});

test("a block's routed turns wait while a Scribe job holds the slot, and go once it is answered", async () => {
  const app = appWith(oneSlot);
  setSwitches(env.db, { transcriber: "scribe" });
  const atScribe = await admitFragment(app, audio(60), 100);
  await app.s.worker.work();
  setSwitches(env.db, { transcriber: "speech" });
  inThaiZone();
  speech.heard = THAI;
  fake.respond = thaiAnswer;
  const jobId = await admitFragment(app, speechAudio(30), 1);
  const working = app.s.worker.work();
  expect(await until(() => speech.blocks === 1)).toBe(true);
  await Bun.sleep(20);
  expect(jobRow(jobId)).toMatchObject({
    maybeBilled: false,
    state: "submitted",
  });
  expect(uploads()).toHaveLength(1);

  await completeByWebhook(app, jobRow(atScribe));
  await working;
  expect(uploads()).toHaveLength(2);
  expect(jobRow(jobId)).toMatchObject({
    maybeBilled: false,
    state: "completed",
  });
});

test("a quiet range that lands while a block waits for its paid slot: nothing of it is sent, then or on a retry", async () => {
  const app = appWith(oneSlot);
  setSwitches(env.db, { transcriber: "scribe" });
  const atScribe = await admitFragment(app, audio(60), 100);
  await app.s.worker.work();
  setSwitches(env.db, { transcriber: "speech" });
  inThaiZone();
  speech.heard = THAI;
  fake.respond = thaiAnswer;
  // Recorded from T0 to T0 + 30 s; its Thai turn waits for the slot.
  const jobId = await admitFragment(app, speechAudio(30), 1);
  const working = app.s.worker.work();
  expect(await until(() => speech.blocks === 1)).toBe(true);
  await Bun.sleep(20);
  expect(uploads()).toHaveLength(1);

  // Meanwhile the Mac reports a dictation over its last second.
  addQuietRange(env.db, {
    endedAt: new Date(T0 + 31_000).toISOString(),
    id: randomUUID(),
    source: "com.apple.dictation",
    startedAt: new Date(T0 + 29_000).toISOString(),
  });
  await completeByWebhook(app, jobRow(atScribe));
  await working;
  expect(uploads()).toHaveLength(1);
  // Withdrawn at the send or on the retry, never sent.
  due(jobId);
  await app.s.worker.work();
  expect(uploads()).toHaveLength(1);
  expect(getJob(env.db, jobId)).toBeUndefined();
});

test("nothing paid goes before the first read of the credits: a wake at boot waits, and credits read out keep the job queued", async () => {
  let answer: (r: Response) => void = () => undefined;
  const quota = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  fake.respond = (call) =>
    call.path.endsWith("/v1/user/subscription") ? quota : Response.json({});
  const app = appWith(oneSlot);
  setSwitches(env.db, { transcriber: "scribe" });
  const jobId = await admitFragment(app, audio(60), 1);
  // A wake just after boot, before the tick read the credits.
  app.s.worker.poke();
  await Bun.sleep(100);
  expect(uploads()).toHaveLength(0);
  answer(Response.json({ character_count: 1000, character_limit: 1000 }));
  await app.s.worker.work.idle();
  await Bun.sleep(20);
  expect(uploads()).toHaveLength(0);
  expect(jobRow(jobId).state).toBe("queued");
});

test("paid sends wait for the balance read, not for the low-credit email", async () => {
  const app = appWith({
    ALERT_EMAIL_FROM: "Alerts <alerts@example.com>",
    ALERT_EMAIL_TO: "owner@example.com",
    RESEND_API_KEY: "re_test",
  });
  fake.respond = () =>
    Response.json({ character_count: 850, character_limit: 1000 });
  // Resend never answers.
  const real = globalThis.fetch;
  spyOn(globalThis, "fetch").mockImplementation(((
    url: string | URL | Request,
    init?: RequestInit
  ) =>
    String(url).startsWith("https://api.resend.com")
      ? new Promise(() => undefined)
      : real(url, init)) as typeof fetch);
  const credits = creditsWatch(env.db, app.s.config);
  credits.check();
  await credits.firstRead();
  expect(credits.level()).toBe("low");
  mock.restore();
});

test("a routed excerpt holds the slot until its words are stored, then dictation waiting for it gets it by itself", async () => {
  const app = appWith(oneSlot);
  setSwitches(env.db, { transcriber: "speech" });
  inThaiZone();
  speech.heard = THAI;
  let dictation: ReturnType<typeof dictate> | undefined;
  fake.respond = (call) => {
    if (call.path.endsWith("/v1/user/subscription")) {
      return Response.json({});
    }
    dictation = dictate(app);
    return thaiAnswer();
  };
  const jobId = await admitFragment(app, speechAudio(30), 1);
  await app.s.worker.work();
  expect(jobRow(jobId).state).toBe("completed");
  expect(await within(500, dictation?.posted ?? Promise.reject())).toBe(true);
  dictation?.free();
});

test("the POST starts its clock: a block that waited 5 minutes for its slot is not lost 26 minutes after it, and never sent twice", async () => {
  const app = appWith(oneSlot);
  setSwitches(env.db, { transcriber: "speech" });
  inThaiZone();
  speech.heard = ALL_THAI;
  const start = Date.now();
  const dictation = dictate(app);
  await dictation.posted;
  const jobId = await admitFragment(app, speechAudio(10), 1);
  const working = app.s.worker.work();
  expect(await until(() => speech.blocks === 1)).toBe(true);
  await Bun.sleep(20);
  setSystemTime(start + 5 * MIN);
  try {
    dictation.free();
    await working;
    const sent = jobRow(jobId);
    expect(sent).toMatchObject({ state: "submitted", transcriber: "scribe" });
    expect(sent.requestSentAt?.getTime()).toBeGreaterThanOrEqual(
      start + 5 * MIN
    );

    // ElevenLabs does not know it yet, 31 minutes after the claim, 26 after the POST.
    setSystemTime(start + 31 * MIN);
    fake.respond = (call) =>
      call.method === "GET" && call.path.includes("/transcripts/")
        ? new Response("not found", { status: 404 })
        : Response.json({ detail: "no" }, { status: 500 });
    await app.s.worker.tick();
    expect(jobRow(jobId).state).toBe("submitted");
    expect(uploads()).toHaveLength(1);
  } finally {
    setSystemTime();
  }
});

test("a block's wait for a slot is what is left of its time since its claim, its audio's read included", async () => {
  const bucket = memoryAudioStore();
  const slow = {
    ...bucket,
    get: (key: string) => {
      // The read takes 9.5 of the block's 10 minutes.
      setSystemTime(Date.now() + 9.5 * MIN);
      return bucket.get(key);
    },
  };
  const app = appWith(oneSlot, slow);
  setSwitches(env.db, { transcriber: "speech" });
  inThaiZone();
  speech.heard = ALL_THAI;
  const dictation = dictate(app);
  await dictation.posted;
  const jobId = await admitFragment(app, speechAudio(10), 1);
  try {
    expect(await within(2000, app.s.worker.work())).toBe(true);
    expect(jobRow(jobId)).toMatchObject({ attempts: 0, state: "queued" });
    expect(uploads()).toHaveLength(0);
  } finally {
    setSystemTime();
    dictation.free();
  }
});

test("a Scribe job is checked once its audio is read: transcription switched off meanwhile, nothing is sent", async () => {
  const bucket = memoryAudioStore();
  const reading = {
    ...bucket,
    get: (key: string) => {
      setSwitches(env.db, { transcription: false });
      return bucket.get(key);
    },
  };
  const app = appWith(oneSlot, reading);
  setSwitches(env.db, { transcriber: "scribe" });
  const jobId = await admitFragment(app, audio(60), 1);
  await app.s.worker.work();
  setSwitches(env.db, { transcription: true });
  expect(uploads()).toHaveLength(0);
  expect(jobRow(jobId)).toMatchObject({ requestSentAt: null, state: "queued" });
});

test("a send that may have been billed holds its slot past 30 minutes until settled: a restart changes nothing", async () => {
  const app = appWith(oneSlot);
  setSwitches(env.db, { transcriber: "scribe" });
  const billed = await admitFragment(app, audio(60), 1);
  env.db
    .update(transcriptionJobs)
    .set({
      maybeBilled: true,
      requestSentAt: new Date(Date.now() - 31 * MIN),
      state: "submitted",
      transcriber: "scribe",
    })
    .where(eq(transcriptionJobs.id, billed))
    .run();
  const waiting = await admitFragment(app, audio(60), 100);
  await app.s.worker.tick();
  expect(jobRow(billed)).toMatchObject({
    maybeBilled: true,
    state: "submitted",
  });
  expect(jobRow(waiting).state).toBe("queued");
  expect(uploads()).toHaveLength(0);
});

test("a block cut off while Scribe may have billed its turns holds the slot until reconcile fails it, and is never sent again", async () => {
  const app = appWith(oneSlot);
  setSwitches(env.db, { transcriber: "scribe" });
  const billed = await admitFragment(app, speechAudio(10), 1);
  env.db
    .update(transcriptionJobs)
    .set({
      maybeBilled: true,
      requestSentAt: new Date(Date.now() - 31 * MIN),
      state: "submitted",
      transcriber: "speech",
    })
    .where(eq(transcriptionJobs.id, billed))
    .run();
  const waiting = await admitFragment(app, audio(60), 100);
  await app.s.worker.work();
  expect(jobRow(waiting).state).toBe("queued");

  await app.s.worker.tick();
  expect(jobRow(billed).state).toBe("failed");
  expect(jobRow(waiting).state).toBe("submitted");
  expect(uploads()).toHaveLength(1);
});

// A submitted row as the worker stores it, `minutes` after its POST.
const submittedAgo = (
  id: string,
  minutes: number,
  set: Partial<typeof transcriptionJobs.$inferInsert> = {}
) =>
  env.db
    .update(transcriptionJobs)
    .set({
      requestSentAt: new Date(Date.now() - minutes * MIN),
      state: "submitted",
      transcriber: "scribe",
      ...set,
    })
    .where(eq(transcriptionJobs.id, id))
    .run();
const failure = (requestId: string | null, metadata: unknown) => ({
  data: {
    error: "it could not be transcribed",
    request_id: requestId,
    status: "failed",
    webhook_metadata: metadata,
  },
  type: "speech_to_text_transcription",
});

test("a failure after the job's transcript changes nothing: a completed job is never sent again", async () => {
  const app = appWith(oneSlot);
  setSwitches(env.db, { transcriber: "scribe" });
  const jobId = await admitFragment(app, audio(60), 1);
  await app.s.worker.work();
  const sent = jobRow(jobId);
  await completeByWebhook(app, sent);
  const metadata = uploads()[0]?.form?.get("webhook_metadata");
  await deliver(app, failure(sent.providerRequestId, metadata));
  due(jobId);
  await app.s.worker.work();
  expect(jobRow(jobId).state).toBe("completed");
  expect(uploads()).toHaveLength(1);
});

test("a whole block sent to Scribe again is a new send: a late failure of the first never touches the second, and it goes at most three times", async () => {
  const app = appWith(oneSlot);
  setSwitches(env.db, { transcriber: "speech" });
  inThaiZone();
  speech.heard = ALL_THAI;
  const jobId = await admitFragment(app, speechAudio(10), 1);
  await app.s.worker.work();
  const first = jobRow(jobId);
  const firstFailure = failure(
    first.providerRequestId,
    uploads()[0]?.form?.get("webhook_metadata")
  );
  expect(await (await deliver(app, firstFailure)).json()).toMatchObject({
    result: "retried",
  });
  // Heard again on the Mac, it goes to Scribe whole again, its attempts going on.
  due(jobId);
  await app.s.worker.work();
  const second = jobRow(jobId);
  expect(second).toMatchObject({ attempts: 1, state: "submitted" });
  expect(await (await deliver(app, firstFailure)).json()).toMatchObject({
    result: "stale",
  });
  expect(jobRow(jobId)).toMatchObject({
    providerRequestId: second.providerRequestId,
    state: "submitted",
  });
  await app.s.worker.work();
  expect(uploads()).toHaveLength(2);
  // Each later failure is an attempt; the third fails it, never sent a fourth time.
  for (const sent of [2, 3]) {
    // biome-ignore lint/performance/noAwaitInLoops: one send after the other
    await deliver(
      app,
      failure(
        jobRow(jobId).providerRequestId,
        uploads()[sent - 1]?.form?.get("webhook_metadata")
      )
    );
    due(jobId);
    await app.s.worker.work();
  }
  expect(jobRow(jobId)).toMatchObject({ attempts: 3, state: "failed" });
  expect(uploads()).toHaveLength(3);
});

test("a Scribe send with no transcription id (cut off before its answer was stored) holds its slot until settled", async () => {
  const app = appWith(oneSlot);
  setSwitches(env.db, { transcriber: "scribe" });
  const cutOff = await admitFragment(app, audio(60), 1);
  submittedAgo(cutOff, 31);
  const waiting = await admitFragment(app, audio(60), 100);
  await app.s.worker.tick();
  expect(jobRow(cutOff)).toMatchObject({
    maybeBilled: false,
    state: "submitted",
  });
  expect(jobRow(waiting).state).toBe("queued");
  expect(uploads()).toHaveLength(0);
});

// The upgrade as a server runs it (`migrateDb`), from a database that ran `post_clock` or one from before it.
const upgradeFrom = async (ran: "post_clock" | "neither") => {
  const { entries } = await Bun.file(
    join(MIGRATIONS, "meta/_journal.json")
  ).json();
  const postClock = entries.find((entry: { tag: string }) =>
    entry.tag.endsWith("_post_clock")
  ).when;
  // What its own migrations table says it ran: up to post_clock, or up to the one before it.
  env.db.run(
    ran === "post_clock"
      ? sql`delete from __drizzle_migrations where created_at > ${postClock}`
      : sql`delete from __drizzle_migrations where created_at >= ${postClock}`
  );
  // The tables made after it, which its migrations make again.
  env.db.run(sql`drop table phone_dictations`);
  migrateDb(env.db);
};

test.each(["post_clock", "neither"] as const)(
  "a send submitted before 20 Nov has no POST clock: ElevenLabs not knowing it never sends it again, and it fails only after a day (upgraded from a database that ran %s)",
  async (ran) => {
    const app = appWith(oneSlot);
    setSwitches(env.db, { transcriber: "scribe" });
    const legacy = await admitFragment(app, audio(60), 1);
    submittedAgo(legacy, 41, {
      providerRequestId: "req_legacy",
      providerTranscriptionId: "tr_legacy",
    });
    await upgradeFrom(ran);
    fake.respond = (call) =>
      call.method === "GET" && call.path.includes("/transcripts/")
        ? new Response("not found", { status: 404 })
        : Response.json({ detail: "no" }, { status: 500 });
    const waiting = await admitFragment(app, audio(60), 100);
    await app.s.worker.tick();
    expect(jobRow(legacy)).toMatchObject({
      attempts: 0,
      maybeBilled: true,
      state: "submitted",
    });
    expect(jobRow(waiting).state).toBe("queued"); // it still holds the one slot
    submittedAgo(legacy, 25 * 60, { maybeBilled: true });
    await app.s.worker.tick();
    expect(jobRow(legacy)).toMatchObject({ attempts: 0, state: "failed" });
    expect(uploads()).toHaveLength(1); // only the waiting job, sent once the slot came free
  }
);

test("the upgrade fails each Scribe send the old worker put back (ids kept, or cleared by its 'lost by the provider' retry), in the feed, and never POSTs it again; a fresh job still sends", async () => {
  const app = appWith(oneSlot);
  setSwitches(env.db, { transcriber: "scribe" });
  const backoff = await admitFragment(app, audio(60), 1);
  const lost = await admitFragment(app, audio(60), 100);
  const queuedBefore = {
    nextAttemptAt: new Date(Date.now() - MIN),
    requestSentAt: null,
    state: "queued" as const,
    transcriber: "scribe" as const,
  };
  const requeue = (id: string, set: object) =>
    env.db
      .update(transcriptionJobs)
      .set({ ...queuedBefore, ...set })
      .where(eq(transcriptionJobs.id, id))
      .run();
  requeue(backoff, { providerRequestId: "req_legacy" });
  requeue(lost, {
    attempts: 1,
    error: "lost by the provider: no transcript and no callback",
  });
  const seen = latestSeq(env.db);
  await upgradeFrom("neither");
  const feed = await (
    await app.request(`/changes?since=${seen}`, {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    })
  ).json();
  for (const id of [backoff, lost]) {
    expect(jobRow(id)).toMatchObject({ maybeBilled: true, state: "failed" });
    expect(feed.jobs).toContainEqual(
      expect.objectContaining({ id, state: "failed" })
    );
  }
  const fresh = await admitFragment(app, audio(60), 200);
  await app.s.worker.tick();
  expect(uploads()).toHaveLength(1); // only the fresh job
  expect(jobRow(fresh).state).toBe("submitted");
});

test("reconcile frees each slot as it settles it, not after the slowest", async () => {
  const app = appWith({ ...withSpeech, ELEVENLABS_SLOTS: "2" });
  setSwitches(env.db, { transcriber: "scribe" });
  const answered = await admitFragment(app, audio(60), 1);
  const slow = await admitFragment(app, audio(60), 100);
  submittedAgo(answered, 1, { providerTranscriptionId: "tr_answered" });
  submittedAgo(slow, 1, { providerTranscriptionId: "tr_slow" });
  let answer: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  fake.respond = async (call) => {
    if (call.path.endsWith("/tr_answered")) {
      return Response.json(providerTranscript);
    }
    if (call.path.endsWith("/tr_slow")) {
      await held;
      return Response.json(providerTranscript);
    }
    return Response.json({ detail: "no" }, { status: 500 });
  };
  const dictation = dictate(app);
  const ticking = app.s.worker.tick();
  expect(await within(1000, dictation.posted)).toBe(true);
  expect(jobRow(answered).state).toBe("completed");
  expect(jobRow(slow).state).toBe("submitted");
  answer();
  dictation.free();
  await ticking;
});

test("a quiet range that comes while a block's audio is read keeps it from the speech service", async () => {
  const bucket = memoryAudioStore();
  const reading = {
    ...bucket,
    get: (key: string) => {
      addQuietRange(env.db, {
        endedAt: new Date(T0 + 5000).toISOString(),
        id: randomUUID(),
        source: "playback",
        startedAt: new Date(T0).toISOString(),
      });
      return bucket.get(key);
    },
  };
  const app = appWith(oneSlot, reading);
  setSwitches(env.db, { transcriber: "speech" });
  const jobId = await admitFragment(app, speechAudio(10), 1);
  await app.s.worker.work();
  expect(speech.blocks).toBe(0);
  expect(jobRow(jobId)).toMatchObject({ attempts: 0, state: "queued" });
  // Due again, the claim withdraws it, unsent.
  due(jobId);
  await app.s.worker.work();
  expect(speech.blocks).toBe(0);
  expect(getJob(env.db, jobId)).toBeUndefined();
});

test("the transcriber switched to the speech service while a Scribe job's audio is read: it goes there, not to Scribe", async () => {
  const bucket = memoryAudioStore();
  const reading = {
    ...bucket,
    get: (key: string) => {
      setSwitches(env.db, { transcriber: "speech" });
      return bucket.get(key);
    },
  };
  const app = appWith(oneSlot, reading);
  setSwitches(env.db, { transcriber: "scribe" });
  speech.heard = {
    durationSeconds: 10,
    models: {},
    turns: [turn(0, 10, "0", "en")],
    words: [said(1, "Hello")],
  };
  const jobId = await admitFragment(app, speechAudio(10), 1);
  await app.s.worker.work();
  expect(uploads()).toHaveLength(0);
  expect(speech.blocks).toBe(1);
  expect(jobRow(jobId)).toMatchObject({
    state: "completed",
    transcriber: "speech",
  });
});

test("webhooks: a reported failure is an attempt, with null fields too; an unreadable one is kept for reconcile", async () => {
  const app = appWith();
  const reported = await admitFragment(app, audio(60), 1);
  const garbled = await admitFragment(app, audio(60), 100);
  await app.s.worker.work();
  // The metadata of the job's latest POST.
  const sentFor = (id: string) =>
    uploads()
      .map((call) => call.form?.get("webhook_metadata"))
      .findLast((metadata) => String(metadata).includes(id));

  // Oct 13–14: ~650-byte failure webhooks with null fields were ignored unseen.
  const failed = await deliver(app, {
    data: {
      error: { message: "audio could not be decoded" },
      request_id: null,
      status: null,
      transcription: null,
      webhook_metadata: sentFor(reported),
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
  const firstSend = sentFor(reported);
  due(reported);
  await app.s.worker.work();
  const late = await deliver(app, {
    data: { error: "late", webhook_metadata: firstSend },
    type: "speech_to_text_transcription",
  });
  expect(await late.json()).toEqual({ result: "stale" });
  // One from before 20 Nov names no POST: under another request id it changes nothing either.
  const legacy = (requestId: string | null) =>
    deliver(app, {
      data: {
        error: "again",
        request_id: requestId,
        webhook_metadata: JSON.stringify({ attempt: 1, jobId: reported }),
      },
      type: "speech_to_text_transcription",
    });
  expect(await (await legacy("req_of_an_earlier_send")).json()).toEqual({
    result: "stale",
  });
  expect(jobRow(reported).state).toBe("submitted");
  // Under the job's own request id it is that send's: an attempt.
  expect(
    await (await legacy(jobRow(reported).providerRequestId)).json()
  ).toEqual({ result: "retried" });
  expect(jobRow(reported)).toMatchObject({
    attempts: 2,
    state: "queued",
  });
  // The third failure fails it, its pages kept: a failure that repeats never loops.
  due(reported);
  await app.s.worker.work();
  const third = await deliver(app, {
    data: { error: "again", webhook_metadata: sentFor(reported) },
    type: "speech_to_text_transcription",
  });
  expect(await third.json()).toEqual({ result: "failed" });
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
