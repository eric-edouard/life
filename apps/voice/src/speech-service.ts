// Client for the speech service (apps/speech): speaker embeddings for recognition, and a block's
// speaker turns, languages and words for transcription. Audio is forwarded from memory and never
// stored; only what comes back is kept, with its provenance.
import { z } from "zod";
import type { Config } from "./config";
import { switches } from "./switches";

const EMBEDDING_DIMENSIONS = 192;

// Why a call can't be answered now.
type Unanswered =
  | { error: "identity_busy"; retryAfter: string }
  | { error: "invalid_audio" | "identity_unavailable"; message: string };

const Ranges = z.object({
  embeddings: z.array(
    z
      .object({
        durationSeconds: z.number().positive(),
        embedding: z.array(z.number()).length(EMBEDDING_DIMENSIONS),
      })
      .nullable()
  ),
  modelId: z.string().min(1),
  modelRevision: z.string().min(1),
});

type Embedding = NonNullable<z.infer<typeof Ranges>["embeddings"][number]> &
  Omit<z.infer<typeof Ranges>, "embeddings">;

// A block as the speech service heard it, in seconds of its audio: Nemotron's speaker turns (in
// order, apart), VoxLingua107's language of each turn of a second or more, Parakeet Ultra's words.
const Heard = z.object({
  durationSeconds: z.number().nonnegative(),
  models: z.record(z.string(), z.string()),
  turns: z.array(
    z.object({
      end: z.number(),
      language: z.string().nullable(),
      speaker: z.string(),
      start: z.number(),
    })
  ),
  words: z.array(
    z.object({ end: z.number(), start: z.number(), text: z.string() })
  ),
});
export type Heard = z.infer<typeof Heard>;

// The speech service is set up: its address and the secret it shares, both or neither.
export const identitySet = (
  config: Config
): config is Config & { IDENTITY_SECRET: string; IDENTITY_URL: string } =>
  Boolean(config.IDENTITY_URL && config.IDENTITY_SECRET);

// One POST of an Ogg Opus file to the service, and what its answer means. Busy while transcription
// is switched off (the caller tries again later).
async function post<T>(
  config: Config,
  path: string,
  ogg: Uint8Array,
  schema: z.ZodType<T>,
  headers: Record<string, string> = {}
): Promise<{ answer: T } | Unanswered> {
  if (!switches().transcription) {
    return { error: "identity_busy", retryAfter: "3600" };
  }
  if (!identitySet(config)) {
    return {
      error: "identity_unavailable",
      message: "IDENTITY_URL or IDENTITY_SECRET is not set",
    };
  }
  let res: Response;
  try {
    res = await fetch(new URL(path, config.IDENTITY_URL), {
      body: ogg as BodyInit,
      headers: {
        "Content-Type": "audio/ogg",
        "X-Identity-Secret": config.IDENTITY_SECRET,
        ...headers,
      },
      method: "POST",
      signal: AbortSignal.timeout(130_000),
    });
  } catch (error) {
    return { error: "identity_unavailable", message: String(error) };
  }
  if (res.status === 503) {
    return {
      error: "identity_busy",
      retryAfter: res.headers.get("Retry-After") ?? "5",
    };
  }
  if (res.status === 400 || res.status === 413) {
    return { error: "invalid_audio", message: await res.text() };
  }
  const parsed = schema.safeParse(res.ok ? await res.json() : null);
  return parsed.success
    ? { answer: parsed.data }
    : {
        error: "identity_unavailable",
        message: `the speech service answered ${res.status}`,
      };
}

// One embedding per `[start, end]` range (seconds) of an Ogg Opus file, in order; null for a range
// the service could not use (past the end of the audio, or under half a second).
export async function embedRanges(
  config: Config,
  ogg: Uint8Array,
  ranges: [number, number][]
): Promise<{ embeddings: (Embedding | null)[] } | Unanswered> {
  const said = await post(config, "/embed-ranges", ogg, Ranges, {
    "X-Ranges": JSON.stringify(ranges),
  });
  if (!("answer" in said)) {
    return said;
  }
  const { embeddings, ...model } = said.answer;
  return { embeddings: embeddings.map((e) => e && { ...e, ...model }) };
}

// A block's turns, languages and words (route-turns.ts decides what goes to Scribe).
export async function transcribeBlock(
  config: Config,
  ogg: Uint8Array
): Promise<{ heard: Heard } | Unanswered> {
  const said = await post(config, "/transcribe", ogg, Heard);
  return "answer" in said ? { heard: said.answer } : said;
}
