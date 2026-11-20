// Paid sends through the job worker with one ElevenLabs slot: dictation beside the pendant's blocks,
// the POST's own clock, and slots freed by what settles them (scribe-slots.ts holds the order rules).
import { expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MIGRATIONS } from "@lifelog/db";
import { transcriptionJobs } from "@lifelog/db/schema";
import { eq, sql } from "drizzle-orm";
import { memoryAudioStore } from "./audio-store";
import { jobBench } from "./job-bench";
import { getJob } from "./jobs";
import { addQuietRange } from "./quiet-ranges";
import { setSwitches } from "./switches";
import { providerTranscript } from "./testing";

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
  expect(await until(() => jobRow(older).state === "submitted")).toBe(true);
  expect(uploads()).toHaveLength(2);
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

test("a routed excerpt holds the slot until its words are stored, then dictation waiting for it gets it by itself", async () => {
  const app = appWith(oneSlot);
  setSwitches(env.db, { transcriber: "speech" });
  inThaiZone();
  speech.heard = THAI;
  let dictation: ReturnType<typeof dictate> | undefined;
  fake.respond = () => {
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

test("a whole block sent to Scribe again is a new send: a late failure of the first never touches the second", async () => {
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
  // Heard again on the Mac, it goes to Scribe whole again, its attempts started again at 0.
  due(jobId);
  await app.s.worker.work();
  const second = jobRow(jobId);
  expect(second).toMatchObject({ attempts: 0, state: "submitted" });
  expect(await (await deliver(app, firstFailure)).json()).toMatchObject({
    result: "stale",
  });
  expect(jobRow(jobId)).toMatchObject({
    providerRequestId: second.providerRequestId,
    state: "submitted",
  });
  await app.s.worker.work();
  expect(uploads()).toHaveLength(2);
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

test("a send stamped at its claim before 20 Nov is moved to its latest POST: ElevenLabs not knowing it 31 minutes after its claim does not send it again", async () => {
  const app = appWith(oneSlot);
  setSwitches(env.db, { transcriber: "scribe" });
  const legacy = await admitFragment(app, audio(60), 1);
  submittedAgo(legacy, 31, {
    providerRequestId: "req_legacy",
    providerTranscriptionId: "tr_legacy",
  });
  env.db.run(
    sql.raw(
      await Bun.file(join(MIGRATIONS, "20261120141310_post_clock.sql")).text()
    )
  );
  fake.respond = (call) =>
    call.method === "GET" && call.path.includes("/transcripts/")
      ? new Response("not found", { status: 404 })
      : Response.json({ detail: "no" }, { status: 500 });
  await app.s.worker.tick();
  expect(jobRow(legacy).state).toBe("submitted");
  expect(uploads()).toHaveLength(0);
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
