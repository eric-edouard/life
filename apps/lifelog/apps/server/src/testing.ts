// Test support: a disposable SQLite file per test file and a local fake of the ElevenLabs HTTP API.
// Never used by the server itself.

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock } from "@life/server/src/core/clock";
import { connect, type Db, migrateDb } from "@lifelog/db";
import {
  conversations,
  heartbeats,
  ownerEdits,
  type Turn,
  transcriptionJobs,
  transcripts,
  type Word,
} from "@lifelog/db/schema";
import { eq, sql } from "drizzle-orm";
import { pendantOggOpus } from "./audio";
import { logChange } from "./change-log";
import { type Config, loadConfig, sha256Hex } from "./config";
import { PARSER_VERSION } from "./elevenlabs";
import { markDirty, pendantSources, regroupAfterCommit } from "./grouping";
import { requestRoll } from "./intelligence";
import type { ModelCall, Provider } from "./providers";
import { services } from "./services";
import type { Heard } from "./speech-service";
import { rebuildTurns } from "./turns";

export const OWNER_TOKEN = "owner-test-token";
export const WEBHOOK_SECRET = "whsec-test";

// The archive, migrated, in a file of its own; `reset` empties every table between tests. The
// change log's seq keeps growing across them, as in production, so a reader's cursor held by a
// service built once per file never points past the newest change.
export function testDb() {
  const dir = mkdtempSync(join(tmpdir(), "lifelog-test-"));
  const db = connect(join(dir, "archive.sqlite"));
  migrateDb(db);
  const tables = db
    .all<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%'
        and name not like '__drizzle%' and name not like 'search_text%'`
    )
    .map((t) => t.name);
  return {
    db,
    drop: () => {
      db.$client.close(true);
      rmSync(dir, { force: true, recursive: true });
    },
    reset: () => {
      db.$client.run("pragma foreign_keys = off");
      db.transaction((tx) => {
        for (const table of tables) {
          tx.run(sql.raw(`delete from "${table}"`));
        }
      });
      db.$client.run("pragma foreign_keys = on");
    },
  };
}

// A completed job with this transcript; returns the job id. Stored an hour ago unless `storedAt`
// says otherwise.
export function seedTranscript(
  db: Db,
  turns: Turn[],
  words: Word[] = [],
  storedAt = new Date(clock().getTime() - 3_600_000)
) {
  const job = db
    .insert(transcriptionJobs)
    .values({
      audioSha256: randomUUID(),
      billableSeconds: 60,
      preparedDurationSeconds: 60,
      settings: { keyterms: [], languageCode: null, numSpeakers: null },
      settingsHash: randomUUID(),
      state: "completed",
    })
    .returning()
    .get();
  if (!job) {
    throw new Error("no job");
  }
  storeTranscript(db, job.id, turns, words, storedAt);
  return job.id;
}

// A job's transcript with these turns and words, as parsed from the provider.
export function storeTranscript(
  db: Db,
  jobId: string,
  turns: Turn[],
  words: Word[] = [],
  storedAt = clock()
) {
  db.insert(transcripts)
    .values({
      createdAt: storedAt,
      jobId,
      languageCode: "eng",
      parsed: { languageCode: "eng", languageProbability: 1, turns, words },
      parserVersion: PARSER_VERSION,
      raw: {},
    })
    .run();
}

// A job's time map, as its block brings it, and its turns built from it.
export function mapJob(
  db: Db,
  jobId: string,
  segments: [number, number][],
  separatorMs = 400,
  starts?: number[]
) {
  db.update(transcriptionJobs)
    .set({
      captureEnd: new Date(Math.max(...segments.map(([, b]) => b))),
      captureStart: new Date(Math.min(...segments.map(([a]) => a))),
      map: { segments, separatorMs, ...(starts && { starts }) },
    })
    .where(eq(transcriptionJobs.id, jobId))
    .run();
  rebuildTurns(db, jobId);
}

// A live conversation over [at, at + ms) holding one job with these turns, its prepared audio laid
// from `at` in one stretch. Returns their ids.
export function seedConversation(
  db: Db,
  turns: Turn[],
  {
    at = Date.parse("2026-10-01T02:00:00Z"),
    id = randomUUID(),
    ms = 600_000,
    words = [] as Word[],
  } = {}
) {
  db.insert(conversations)
    .values({
      captureEndedAt: new Date(at + ms),
      captureStartedAt: new Date(at),
      id,
    })
    .run();
  const jobId = seedTranscript(db, turns, words);
  mapJob(db, jobId, [[at, at + ms]]);
  return { id, jobId };
}

// A text model that answers each call with `respond`; every call is recorded.
export function fakeModel(respond: (call: ModelCall) => unknown = fakeAnswer) {
  const calls: ModelCall[] = [];
  const provider: Provider & { calls: ModelCall[] } = {
    call: async (call) => {
      calls.push(call);
      const answer = await respond(call);
      return {
        inputTokens: 1000,
        outputTokens: 100,
        text: typeof answer === "string" ? answer : JSON.stringify(answer),
      };
    },
    calls,
    model: "claude-sonnet-5-5",
    name: "claude-code",
  };
  return provider;
}

// Retries that ask again at once, so a test of an unusable answer never waits the backoff.
export const NO_WAIT = { count: 2, delayMs: 0 };

// One roll of a conversation on `model`, retries without waiting: its run
// once settled, or null when there was nothing to roll.
export async function rollNow(
  db: Db,
  model: Provider,
  conversationId: string,
  { open = false, windowChars = 100_000 } = {}
) {
  const started = requestRoll(db, model, conversationId, {
    open,
    retries: NO_WAIT,
    windowChars,
  });
  if (started === "busy") {
    throw new Error("a roll is running");
  }
  return started ? await started.work : null;
}

const RANGE = /The turns shown are (\d+) to (\d+)/;
// The turn ids a call was asked about.
export const rangeOf = (call: ModelCall) => {
  const [, a = "0", b = "0"] = RANGE.exec(call.user) ?? [];
  return [Number(a), Number(b)] as const;
};

// One speaker as the voices call describes it: live, not talking with the owner, unnamed,
// unless `fields` say otherwise.
export const speakerAnswer = (
  fields: Partial<Record<string, unknown>> & { speaker: string }
) => ({
  evidenceTurnIds: [],
  kind: "live",
  knownPerson: "",
  name: "",
  withOwner: false,
  ...fields,
});

// A valid answer to the voices call: no speaker named.
export const fakeAnswer = () => ({ speakers: [] });

// A stored result as a valid run over turns first..last has it.
export function storedResult(first: number, last: number) {
  return {
    boundarySuggestions: [],
    chapters: [
      {
        endTurnId: last,
        evidenceTurnIds: [first],
        startTurnId: first,
        summary: "Everything.",
        title: "All of it",
      },
    ],
    languages: ["en"],
    speakers: [],
    title: { evidenceTurnIds: [first], text: `Turns ${first}-${last}` },
    tldr: { evidenceTurnIds: [first, last], text: "They talked." },
  };
}

interface FakeCall {
  form: FormData | null;
  method: string;
  path: string;
}

// Each test sets `respond`; every request is recorded in `calls`.
export function fakeElevenLabs() {
  const fake: {
    calls: FakeCall[];
    respond: (call: FakeCall) => Response | Promise<Response>;
  } = {
    calls: [],
    respond: () => new Response("no handler", { status: 500 }),
  };
  const server = Bun.serve({
    fetch: async (req) => {
      const call = {
        form: req.headers.get("content-type")?.startsWith("multipart/")
          ? await req.formData()
          : null,
        method: req.method,
        path: new URL(req.url).pathname,
      };
      fake.calls.push(call);
      return fake.respond(call);
    },
    port: 0,
  });
  return Object.assign(fake, { server });
}

// A stand-in for apps/identity. The "excerpt" is a JSON vector, returned as its embedding. For
// /embed-ranges, `cut` says what each range holds (null: unusable), and `ranges` records every call.
// /transcribe answers `heard` (500 while `failing`, a 200 cut off mid-body while `cutOff`), after
// `meanwhile`; `blocks` counts its calls.
export function fakeSpeechService() {
  const fake: {
    blocks: number;
    busy: boolean;
    cutOff: boolean;
    failing: boolean;
    meanwhile: () => void;
    cut: (range: [number, number]) => {
      durationSeconds: number;
      embedding: number[];
    } | null;
    heard: Heard;
    /** Each block's `X-Priority`. */
    priorities: string[];
    ranges: [number, number][][];
  } = {
    blocks: 0,
    busy: false,
    cut: ([from, to]) => ({
      durationSeconds: to - from,
      embedding: Array.from({ length: 192 }, (_, i) => (i === 5 ? 1 : 0)),
    }),
    cutOff: false,
    failing: false,
    heard: { durationSeconds: 0, models: {}, turns: [], words: [] },
    meanwhile: () => undefined,
    priorities: [],
    ranges: [],
  };
  const server = Bun.serve({
    fetch: async (req) => {
      if (fake.busy) {
        return new Response("busy", {
          headers: { "Retry-After": "7" },
          status: 503,
        });
      }
      if (new URL(req.url).pathname === "/transcribe") {
        fake.blocks += 1;
        fake.priorities.push(req.headers.get("X-Priority") ?? "ordinary");
        fake.meanwhile();
        if (fake.cutOff) {
          return new Response(JSON.stringify(fake.heard).slice(0, 20), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return fake.failing
          ? new Response("RuntimeError", { status: 500 })
          : Response.json(fake.heard);
      }
      if (new URL(req.url).pathname === "/embed-ranges") {
        const ranges = JSON.parse(req.headers.get("X-Ranges") ?? "[]");
        fake.ranges.push(ranges);
        return Response.json({
          embeddings: ranges.map(fake.cut),
          modelId: "test/ecapa",
          modelRevision: "r1",
        });
      }
      // The map places each vector at its first two values.
      const { vectors } = (await req.json()) as { vectors: number[][] };
      return Response.json({ points: vectors.map((v) => [v[0], v[1]]) });
    },
    port: 0,
  });
  return Object.assign(fake, { server });
}

// The speech routes' shared world (routes/voice-notes.ts, routes/dictation.ts): the fakes' services,
// the owner where Thai is spoken (the router's lower bar), turns as the speech service hears them,
// Scribe's Thai answer, and pendant-shaped audio Scribe's excerpts can be cut from.
export const speechServices = (
  scribe: ReturnType<typeof fakeElevenLabs>,
  speech: ReturnType<typeof fakeSpeechService>,
  db: Db,
  overrides: Record<string, string> = {}
) =>
  services(
    testConfig(`http://localhost:${scribe.server.port}`, {
      IDENTITY_SECRET: "speech-test-secret",
      IDENTITY_URL: `http://localhost:${speech.server.port}`,
      ...overrides,
    }),
    db
  );
export const heardInBangkok = (db: Db) =>
  db
    .insert(heartbeats)
    .values({
      body: { timeZone: "Asia/Bangkok" },
      id: randomUUID(),
      observedAt: new Date(0),
      reason: "periodic",
      receivedAt: new Date(0),
    })
    .run();
const SCORES = {
  en: { en: 0.95, fr: 0.02, th: 0.001 },
  fr: { en: 0.02, fr: 0.95, th: 0.001 },
  th: { en: 0.02, fr: 0.01, th: 0.9 },
};
export const spokenTurn = (
  start: number,
  end: number,
  language: keyof typeof SCORES
) => ({
  end,
  language,
  scores: SCORES[language],
  speaker: language === "th" ? "1" : "0",
  start,
});
export const spokenWord = (start: number, text: string) => ({
  end: start + 0.3,
  start,
  text,
});
// English, a Thai turn, French: only the Thai turn goes to Scribe.
export const MIXED_HEARD = {
  durationSeconds: 60,
  models: {},
  turns: [
    spokenTurn(0, 10, "en"),
    spokenTurn(10, 14, "th"),
    spokenTurn(14, 60, "fr"),
  ],
  words: [spokenWord(1, "Hello"), spokenWord(15, "Salut")],
};
export const scribeThai = () =>
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
export const pendantOgg = (seconds: number) =>
  pendantOggOpus(
    Array.from(
      { length: seconds * 50 },
      (_, i) => new Uint8Array([8, i % 256, Math.floor(i / 256)])
    ),
    seconds * 1000
  );

// A minimal Ogg Opus file (RFC 7845) lasting `seconds`: OpusHead, then one page of random
// packet bytes (so every file hashes differently) whose granule position ends the stream.
export function oggOpus(seconds: number, preSkip = 312) {
  const page = (body: Uint8Array, granule: number) => {
    const header = new Uint8Array(28);
    const view = new DataView(header.buffer);
    header.set(new TextEncoder().encode("OggS"));
    view.setBigInt64(6, BigInt(granule), true);
    header[26] = 1;
    header[27] = body.length;
    return [...header, ...body];
  };
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"));
  head[8] = 1;
  head[9] = 1;
  new DataView(head.buffer).setUint16(10, preSkip, true);
  return new Uint8Array([
    ...page(head, 0),
    ...page(randomBytes(64), preSkip + Math.round(seconds * 48_000)),
  ]);
}

export const testConfig = (
  baseUrl: string,
  overrides: Record<string, string | undefined> = {}
): Config =>
  loadConfig({
    DATABASE_PATH: ":memory:",
    DEVICE_TOKEN_HASH: sha256Hex(OWNER_TOKEN),
    ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_BASE_URL: baseUrl,
    ELEVENLABS_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PUBLIC_BASE_URL: "http://localhost",
    ...overrides,
  });

export function signature(
  body: string,
  t = Math.floor(clock().getTime() / 1000)
) {
  const v0 = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${t}.${body}`)
    .digest("hex");
  return `t=${t},v0=${v0}`;
}

// A provider transcript: two speakers, spacing tokens, one audio event.
export const providerTranscript = {
  language_code: "eng",
  language_probability: 0.98,
  text: "Hello there. Bonjour!",
  transcription_id: "tr_1",
  words: [
    {
      end: 0.4,
      logprob: -0.1,
      speaker_id: "speaker_0",
      start: 0,
      text: "Hello",
      type: "word",
    },
    {
      end: 0.5,
      logprob: 0,
      speaker_id: "speaker_0",
      start: 0.4,
      text: " ",
      type: "spacing",
    },
    {
      end: 0.9,
      logprob: -0.2,
      speaker_id: "speaker_0",
      start: 0.5,
      text: "there.",
      type: "word",
    },
    {
      end: 1.2,
      logprob: 0,
      speaker_id: "speaker_0",
      start: 0.9,
      text: " ",
      type: "spacing",
    },
    {
      end: 1.5,
      logprob: 0,
      speaker_id: "speaker_1",
      start: 1.2,
      text: "(laughs)",
      type: "audio_event",
    },
    {
      end: 2,
      logprob: -0.3,
      speaker_id: "speaker_1",
      start: 1.5,
      text: "Bonjour!",
      type: "word",
    },
  ],
};

// An owner's grouping edit as it is stored (no route writes one now): its row, the feed's log of it
// and its range regrouped.
export function storeEdit(db: Db, row: typeof ownerEdits.$inferInsert) {
  db.transaction((tx) => {
    tx.insert(ownerEdits).values(row).run();
    logChange(tx, "edit", [row.id as string]);
    const from = row.at ?? row.from;
    if (from) {
      markDirty(tx, pendantSources(tx), [+from, +(row.to ?? from)]);
    }
  });
  regroupAfterCommit(db, pendantSources(db));
}

// A conversation's words changed: the next drain rolls it.
export async function roll(
  db: Db,
  rolling: { drain: () => Promise<void> },
  id: string
) {
  logChange(db, "conversation", id);
  await rolling.drain();
}
