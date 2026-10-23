// Test support: a disposable SQLite file per test file and a local fake of the ElevenLabs HTTP API.
// Never used by the server itself.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Db, migrateDb } from "@life/voice-db";
import {
  conversations,
  type Turn,
  transcriptionJobs,
  transcripts,
  type Word,
} from "@life/voice-db/schema";
import { eq, sql } from "drizzle-orm";
import { type Config, loadConfig, sha256Hex } from "./config";
import { PARSER_VERSION } from "./elevenlabs";
import { requestRoll } from "./intelligence";
import type { ModelCall, Provider } from "./providers";
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
  storedAt = new Date(Date.now() - 3_600_000)
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
  storedAt = new Date()
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

// One roll of a conversation on `model`, every chapter closing, retries without waiting: its run
// once settled, or null when there was nothing to roll.
export async function rollNow(
  db: Db,
  model: Provider,
  conversationId: string,
  { open = false, windowChars = 100_000 } = {}
) {
  const started = requestRoll(db, model, conversationId, {
    open,
    retries: { count: 2, delayMs: 0 },
    windowChars,
  });
  if (started === "busy") {
    throw new Error("a roll is running");
  }
  return started ? await started.work : null;
}

// Which call of a run this is, by the schema it asks for.
export function stageOf(call: ModelCall) {
  const keys = Object.keys(
    (call.schema as { properties?: object }).properties ?? {}
  );
  if (keys.includes("boundaries")) {
    return "chapters";
  }
  return keys.includes("summary") ? "chapter" : "overview";
}

const RANGE = /(?:must cover turns|: turns|has turns) (\d+) to (\d+)/;
const rangeOf = (call: ModelCall) => {
  const [, a = "0", b = "0"] = RANGE.exec(call.user) ?? [];
  return [Number(a), Number(b)] as const;
};

// One speaker as the chapters call describes it: live, not talking with the owner, unnamed,
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

// A valid answer to whichever call this is: one chapter over the range asked, a summary
// citing its first turn, and "Turns a-b" over the whole.
export function fakeAnswer(call: ModelCall) {
  const [first, last] = rangeOf(call);
  switch (stageOf(call)) {
    case "chapters":
      return {
        boundaries: [],
        chapters: [{ endTurnId: last, startTurnId: first, title: "All of it" }],
        languages: ["en"],
        speakers: [],
      };
    case "chapter":
      return { evidenceTurnIds: [first], summary: "Everything." };
    default:
      return {
        title: { evidenceTurnIds: [first], text: `Turns ${first}-${last}` },
        tldr: { evidenceTurnIds: [first, last], text: "They talked." },
      };
  }
}

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

// A stand-in for apps/speech. The "excerpt" is a JSON vector, returned as its embedding. For
// /embed-ranges, `cut` says what each range holds (null: unusable), and `ranges` records every call.
export function fakeIdentity() {
  const fake: {
    busy: boolean;
    cut: (range: [number, number]) => {
      durationSeconds: number;
      embedding: number[];
    } | null;
    ranges: [number, number][][];
  } = {
    busy: false,
    cut: ([from, to]) => ({
      durationSeconds: to - from,
      embedding: Array.from({ length: 192 }, (_, i) => (i === 5 ? 1 : 0)),
    }),
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

export function signature(body: string, t = Math.floor(Date.now() / 1000)) {
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
