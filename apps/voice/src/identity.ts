// Client for the speaker embedding service (apps/speech). Audio is forwarded from memory and
// never stored; only the embeddings and their provenance are kept.
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

// Speaker recognition is set up: the service's address and the secret it shares, both or neither.
export const identitySet = (
  config: Config
): config is Config & { IDENTITY_SECRET: string; IDENTITY_URL: string } =>
  Boolean(config.IDENTITY_URL && config.IDENTITY_SECRET);

// One embedding per `[start, end]` range (seconds) of an Ogg Opus file, in order; null for a range
// the service could not use (past the end of the audio, or under half a second). Busy while
// transcription is switched off (the tick tries again later).
export async function embedRanges(
  config: Config,
  ogg: Uint8Array,
  ranges: [number, number][]
): Promise<{ embeddings: (Embedding | null)[] } | Unanswered> {
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
    res = await fetch(new URL("/embed-ranges", config.IDENTITY_URL), {
      body: ogg as BodyInit,
      headers: {
        "Content-Type": "audio/ogg",
        "X-Identity-Secret": config.IDENTITY_SECRET,
        "X-Ranges": JSON.stringify(ranges),
      },
      method: "POST",
      signal: AbortSignal.timeout(130_000),
    });
  } catch (error) {
    return {
      error: "identity_unavailable",
      message: String(error),
    };
  }
  if (res.status === 503) {
    return {
      error: "identity_busy",
      retryAfter: res.headers.get("Retry-After") ?? "5",
    };
  }
  if (res.status === 400 || res.status === 413) {
    return {
      error: "invalid_audio",
      message: await res.text(),
    };
  }
  const parsed = Ranges.safeParse(res.ok ? await res.json() : null);
  if (!parsed.success) {
    return {
      error: "identity_unavailable",
      message: `identity service answered ${res.status}`,
    };
  }
  const { embeddings, ...model } = parsed.data;
  return { embeddings: embeddings.map((e) => e && { ...e, ...model }) };
}
