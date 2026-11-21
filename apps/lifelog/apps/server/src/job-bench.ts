// The job worker's test bench (jobs.test.ts, scribe-dispatch.test.ts): a fake ElevenLabs and
// speech service, a test database reset before each test, and the helpers that admit a block and
// read its job. Call it once at the top of a test file.
import { afterAll, afterEach, beforeEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { clock } from "@life/server/src/core/clock";
import { heartbeats } from "@lifelog/db/schema";
import { sql } from "drizzle-orm";
import { createApp } from "./app";
import { pendantOggOpus } from "./audio";
import { blockKey, memoryAudioStore } from "./audio-store";
import { sha256Hex } from "./config";
import { admit, storeFragment } from "./cutter";
import { getJob, type JobWorker } from "./jobs";
import { services } from "./services";
import {
  fakeElevenLabs,
  fakeSpeechService,
  OWNER_TOKEN,
  oggOpus,
  providerTranscript,
  signature,
  testConfig,
  testDb,
} from "./testing";
import { blockKeyterms } from "./vocabulary";

export function jobBench() {
  const fake = fakeElevenLabs();
  const baseUrl = `http://localhost:${fake.server.port}`;
  const speech = fakeSpeechService();
  const withSpeech = {
    IDENTITY_SECRET: "speech-test-secret",
    IDENTITY_URL: `http://localhost:${speech.server.port}`,
  };
  const env = testDb();
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
  // Every test's app shares the one db, and a job worker is one per db: each test's stop, their rounds settled, before
  // the next test resets it.
  const workers: JobWorker[] = [];
  afterEach(() =>
    Promise.all(workers.splice(0).map((worker) => worker.stop()))
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
    workers.push(s.worker);
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
      sql`update transcription_jobs set next_attempt_at = ${clock().getTime() - 1000} where id = ${id}`
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
  // VoxLingua's scores as it gives them for a clear turn of English, French or Thai.
  const SCORES: Record<string, { en: number; fr: number; th: number }> = {
    en: { en: 0.95, fr: 0.02, th: 0.001 },
    fr: { en: 0.02, fr: 0.95, th: 0.001 },
    th: { en: 0.02, fr: 0.01, th: 0.9 },
  };
  const turn = (
    start: number,
    end: number,
    speaker: string,
    language: string | null
  ) => ({
    end,
    language,
    scores: language ? (SCORES[language] ?? null) : null,
    speaker,
    start,
  });
  // The phone named a zone where Thai is spoken, before any block: the router's bar there.
  const inThaiZone = () =>
    env.db
      .insert(heartbeats)
      .values({
        body: { timeZone: "Asia/Bangkok" },
        id: randomUUID(),
        observedAt: new Date(0),
        reason: "periodic",
        receivedAt: new Date(0),
      })
      .run();
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

  return {
    accept,
    admitFragment,
    appWith,
    audio,
    auth,
    baseUrl,
    completeByWebhook,
    deliver,
    due,
    env,
    fake,
    inThaiZone,
    jobRow,
    keep,
    SOURCE,
    said,
    sentAudio,
    speech,
    speechAudio,
    T0,
    thaiAnswer,
    turn,
    uploads,
    withSpeech,
  };
}
