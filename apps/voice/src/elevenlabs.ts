// ElevenLabs Scribe v2 over plain fetch. Facts in docs/research/elevenlabs.md.
// No SDK on purpose: its automatic retries can resubmit a paid POST.
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ParsedTranscript,
  TranscriptionSettings,
  Turn,
  Word,
} from "@lifelog/db/schema";
import { z } from "zod";
import { type Config, ownerTimeZone } from "./config";

// 2: each word keeps the provider spacing before it (Thai comes as one token per letter, unspaced).
// 3: a pause splits a turn only where the provider put a space, never inside a Thai word.
export const PARSER_VERSION = 3;
const SIGNATURE_MAX_AGE_SECONDS = 30 * 60;
// A send: the upload, and without a webhook the transcription too.
const SEND_TIMEOUT_MS = 10 * 60 * 1000;
// A press waits for its words: 5 minutes of audio come back in seconds.
const QUICK_TIMEOUT_MS = 60 * 1000;
const UNIX_SECONDS = /^\d+$/;
// Bun fetch error codes raised before any connection exists: the request never left.
const NEVER_SENT = new Set(["ConnectionRefused", "ENOTFOUND", "EAI_AGAIN"]);

// The key or the plan refused, not the audio: not taken, and fine once the account is.
const ACCOUNT_REFUSED = new Set([401, 403]);

export type SubmitOutcome =
  | { kind: "accepted"; requestId: string; transcriptionId: string | null }
  | { kind: "completed"; raw: unknown }
  // Not taken, so not billed: no room now (429), the account refused, or the request never left.
  // Sent again later.
  | { kind: "later"; error: string }
  // This audio or request is refused (another 4xx): sending it again changes nothing.
  | { kind: "refused"; error: string }
  // The provider may have taken (and billed) it: never sent again; its webhook settles it.
  | { kind: "unknown"; error: string };

const Accepted = z.object({
  request_id: z.string().min(1),
  transcription_id: z.string().nullish(),
});

export function submit(
  config: Config,
  job: { attempts: number; id: string; settings: TranscriptionSettings },
  audio: Blob
): Promise<SubmitOutcome> {
  const { languageCode, numSpeakers, keyterms } = job.settings;
  const { ELEVENLABS_WEBHOOK_ID: webhookId, ELEVENLABS_WEBHOOK_SECRET } =
    config;
  // Without a webhook (a host no one can call), the answer is the transcript itself.
  const webhook = ELEVENLABS_WEBHOOK_SECRET
    ? {
        webhook: "true",
        webhook_metadata: JSON.stringify({
          attempt: job.attempts,
          jobId: job.id,
        }),
        ...(webhookId ? { webhook_id: webhookId } : {}),
      }
    : {};
  return post(
    config,
    audio,
    {
      diarize: "true",
      ...webhook,
      ...(languageCode ? { language_code: languageCode } : {}),
      ...(numSpeakers ? { num_speakers: String(numSpeakers) } : {}),
    },
    keyterms,
    SEND_TIMEOUT_MS
  );
}

// Transcribes a press's audio at once (routes/quick.ts): no webhook, so the answer is the transcript, and no
// diarization, which only slows it: a press asks about the words, not who said them. `billed` false: refused before
// it could cost anything.
export async function transcribeNow(
  config: Config,
  audio: Blob,
  keyterms: string[]
): Promise<
  | { kind: "done"; transcript: ParsedTranscript }
  | { billed: boolean; error: string; kind: "failed" }
> {
  const answer = await post(
    config,
    audio,
    { diarize: "false" },
    keyterms,
    QUICK_TIMEOUT_MS
  );
  if (answer.kind === "completed" && isTranscript(answer.raw)) {
    return { kind: "done", transcript: parseTranscript(answer.raw).transcript };
  }
  return answer.kind === "completed" || answer.kind === "accepted"
    ? {
        billed: true,
        error: "an answer that isn't a transcript",
        kind: "failed",
      }
    : {
        billed: answer.kind === "unknown",
        error: answer.error,
        kind: "failed",
      };
}

// One POST to Scribe v2 with the fields every send shares, and what its answer means.
async function post(
  config: Config,
  audio: Blob,
  fields: Record<string, string>,
  keyterms: string[],
  timeoutMs: number
): Promise<SubmitOutcome> {
  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("file", audio, "audio");
  form.append("timestamps_granularity", "word");
  form.append("tag_audio_events", "false");
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, value);
  }
  for (const term of keyterms) {
    form.append("keyterms", term);
  }
  try {
    const res = await fetch(`${config.ELEVENLABS_BASE_URL}/v1/speech-to-text`, {
      body: form,
      headers: { "xi-api-key": config.ELEVENLABS_API_KEY },
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return answerOf(res.status, await res.text().catch(() => ""));
  } catch (cause) {
    const code = String((cause as { code?: unknown } | null)?.code ?? "");
    const error = `transport: ${code} ${String(cause)}`;
    return NEVER_SENT.has(code)
      ? { error, kind: "later" }
      : { error, kind: "unknown" };
  }
}

// What ElevenLabs' answer to a send means.
function answerOf(status: number, body: string): SubmitOutcome {
  if (status === 202) {
    const accepted = Accepted.safeParse(safeJson(body));
    return accepted.success
      ? {
          kind: "accepted",
          requestId: accepted.data.request_id,
          transcriptionId: accepted.data.transcription_id ?? null,
        }
      : { error: "202 without request_id", kind: "unknown" };
  }
  if (status >= 200 && status < 300) {
    return { kind: "completed", raw: safeJson(body) };
  }
  const error = `${status} ${body.slice(0, 500)}`;
  if (status === 429 || ACCOUNT_REFUSED.has(status)) {
    return { error, kind: "later" };
  }
  return status < 500 ? { error, kind: "refused" } : { error, kind: "unknown" };
}

// Returns the transcript when it exists, "not_found" on a 404, null otherwise (still running,
// or no answer).
export async function fetchTranscript(
  config: Config,
  transcriptionId: string
): Promise<unknown> {
  const res = await fetch(
    `${config.ELEVENLABS_BASE_URL}/v1/speech-to-text/transcripts/${encodeURIComponent(transcriptionId)}`,
    { headers: { "xi-api-key": config.ELEVENLABS_API_KEY } }
  );
  if (res.status === 404) {
    return "not_found";
  }
  return res.ok ? res.json() : null;
}

const UsageTable = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.unknown())),
});

const Subscription = z.object({
  character_count: z.number(),
  character_limit: z.number(),
});

// The plan's credits this period, which speech-to-text spends too. Once they run out,
// ElevenLabs still accepts an upload (202) but never transcribes it. Null when it doesn't
// answer.
export async function credits(
  config: Config
): Promise<{ limit: number; used: number } | null> {
  try {
    const res = await fetch(
      `${config.ELEVENLABS_BASE_URL}/v1/user/subscription`,
      {
        headers: { "xi-api-key": config.ELEVENLABS_API_KEY },
        signal: AbortSignal.timeout(5000),
      }
    );
    const plan = Subscription.safeParse(res.ok ? await res.json() : null);
    return plan.success
      ? { limit: plan.data.character_limit, used: plan.data.character_count }
      : null;
  } catch {
    return null;
  }
}

// What ElevenLabs itself reports for speech-to-text in [from, to): the whole workspace,
// every key and app, not only this server's jobs. Null when it doesn't answer, so the
// summary never waits on it or fails because of it.
export async function workspaceSpeechToText(
  config: Config,
  from: Date,
  to: Date
): Promise<{ hours: number; usd: number } | null> {
  try {
    const res = await fetch(
      `${config.ELEVENLABS_BASE_URL}/v1/workspace/analytics/query/usage-by-product-over-time`,
      {
        body: JSON.stringify({
          end_time: to.getTime(),
          filters: [
            { column: "product_type", operation: "eq", values: ["STT"] },
          ],
          // Daily buckets from local midnight, so a range starting at midnight there is exact.
          interval_seconds: 86_400,
          start_time: from.getTime(),
          time_zone: ownerTimeZone(),
        }),
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": config.ELEVENLABS_API_KEY,
        },
        method: "POST",
        signal: AbortSignal.timeout(5000),
      }
    );
    const table = UsageTable.safeParse(res.ok ? await res.json() : null);
    if (!table.success) {
      return null;
    }
    const sum = (column: string) => {
      const i = table.data.columns.indexOf(column);
      return i < 0
        ? null
        : table.data.rows.reduce((s, row) => s + Number(row[i] ?? 0), 0);
    };
    const minutes = sum("total_minutes");
    const usd = sum("total_cost");
    return minutes === null || usd === null
      ? null
      : { hours: minutes / 60, usd };
  } catch {
    return null;
  }
}

// `ElevenLabs-Signature: t=<unix>,v0=<hex HMAC-SHA256 of "<t>.<raw body>">`.
export function verifySignature(
  header: string | undefined,
  rawBody: string,
  secret: string,
  nowSeconds = Date.now() / 1000
): boolean {
  const fields = new Map(
    (header ?? "").split(",").map((part) => {
      const at = part.indexOf("=");
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as const;
    })
  );
  const t = fields.get("t") ?? "";
  const v0 = fields.get("v0") ?? "";
  if (
    !UNIX_SECONDS.test(t) ||
    nowSeconds - Number(t) > SIGNATURE_MAX_AGE_SECONDS
  ) {
    return false;
  }
  const expected = createHmac("sha256", secret)
    .update(`${t}.${rawBody}`)
    .digest();
  const given = Buffer.from(v0, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// The failure shape is undocumented (docs/research/elevenlabs.md §2): every field may be absent
// or null. Oct 13–14 a strict schema dropped ~650-byte failure webhooks unseen, so their jobs
// held the provider's slots for 30 minutes each.
export const WebhookEvent = z.object({
  data: z
    .object({
      error: z.unknown().nullish(),
      message: z.unknown().nullish(),
      request_id: z.string().min(1).nullish(),
      status: z.string().nullish(),
      transcription: z.unknown().nullish(),
      webhook_metadata: z.unknown().nullish(),
    })
    .nullish(),
  type: z.string().nullish(),
});

// What a failure webhook says went wrong, when it says.
export function failureReason(data: { error?: unknown; message?: unknown }) {
  const { error, message } = data;
  const nested =
    error && typeof error === "object" && "message" in error
      ? error.message
      : null;
  return (
    [error, nested, message].find(
      (said): said is string => typeof said === "string" && said.length > 0
    ) ?? null
  );
}

// The job and which of its sends (`attempts` when it went; absent before Oct 15).
const WebhookMetadata = z.object({
  attempt: z.int().min(0).optional(),
  jobId: z.uuid(),
});

// webhook_metadata is sent as a JSON string; accept it echoed as a string or an object.
export function webhookMetadata(metadata: unknown) {
  const value = typeof metadata === "string" ? safeJson(metadata) : metadata;
  const parsed = WebhookMetadata.safeParse(value).data;
  return { attempt: parsed?.attempt ?? null, jobId: parsed?.jobId ?? null };
}

const ProviderToken = z.object({
  end: z.number().nullish(),
  logprob: z.number().nullish(),
  speaker_id: z.string().nullish(),
  start: z.number().nullish(),
  text: z.string(),
  type: z.enum(["word", "spacing", "audio_event"]),
});

const ProviderTranscript = z.object({
  language_code: z.string(),
  language_probability: z.number(),
  transcription_id: z.string().nullish(),
  words: z.array(ProviderToken),
});

// Words keep prepared-audio seconds; turns split on every speaker change and after a
// pause before a spaced word, so a turn never carries minutes of other sound (playback,
// voice samples) and a Thai word is never cut in two. Spacing
// tokens are concatenated rather than synthesised, which keeps Thai and punctuation intact:
// Scribe returns Thai one letter cluster per token with no spacing token between them. Each
// word keeps the spacing before it, so any text rebuilt from words matches the provider's.
const TURN_PAUSE_SECONDS = 2;
export const isTranscript = (raw: unknown) =>
  ProviderTranscript.safeParse(raw).success;

export function parseTranscript(raw: unknown): {
  transcript: ParsedTranscript;
  transcriptionId: string | null;
} {
  const transcript = ProviderTranscript.parse(raw);
  const words: Word[] = [];
  const turns: Turn[] = [];
  let spacing = "";
  for (const token of transcript.words) {
    const turn = turns.at(-1);
    if (token.type === "spacing") {
      spacing += token.text;
      if (turn) {
        turn.text += token.text;
      }
      continue;
    }
    const word = toWord(token, spacing);
    if (!word) {
      continue;
    }
    spacing = "";
    words.push(word);
    if (
      turn?.speakerId === word.speakerId &&
      (word.start - turn.end <= TURN_PAUSE_SECONDS || word.spacing === "")
    ) {
      turn.text += word.text;
      turn.end = word.end;
    } else {
      const { end, speakerId, start, text } = word;
      turns.push({ end, speakerId, start, text });
    }
  }
  for (const each of turns) {
    each.text = each.text.trim();
  }
  return {
    transcript: {
      languageCode: transcript.language_code,
      languageProbability: transcript.language_probability,
      turns,
      words,
    },
    transcriptionId: transcript.transcription_id ?? null,
  };
}

// Words back into text with the provider's own spacing: never add a space Thai doesn't have.
export const textOf = (words: Pick<Word, "spacing" | "text">[]) =>
  words.map((w, i) => (i === 0 ? w.text : w.spacing + w.text)).join("");

// ponytail: audio events and untimed words are dropped; keep them if the UI needs them.
function toWord(
  token: z.infer<typeof ProviderToken>,
  spacing: string
): Word | null {
  const { end, start } = token;
  if (
    token.type !== "word" ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    end < start
  ) {
    return null;
  }
  return {
    end,
    logprob: token.logprob ?? null,
    spacing,
    speakerId: token.speaker_id ?? null,
    start,
    text: token.text,
  };
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
