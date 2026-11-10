import { z } from "zod";
import { digest } from "./hash";

// Search by meaning's model, for lifelog's voice and Life's memory alike: EmbeddingGemma-300M (Q8), run on the Mac by
// llama.cpp's server, which Lifelog Host keeps running (its `embedder` child). Chosen on 5 Nov 2026 against OpenAI's
// text-embedding-3-large and seven open models, on the owner's French, English and Thai queries (his data repo,
// docs/research/embedding-bench-2026-11-05). Nothing it embeds leaves the Mac.

/** The model's id, kept on every stored vector: a vector of another model is never compared with this one's. */
export const EMBEDDER_MODEL = "embeddinggemma-300m-q8";
export const EMBEDDER_DIMENSIONS = 768;
/** The model's file, pinned: Lifelog Host bundles it (apps/lifelog/scripts/host-app.ts). A new file is a new `EMBEDDER_MODEL`. */
export const EMBEDDER_FILE = {
  sha256: "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63",
  url: "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/0f741b5a6585bd53aeb15cd1372c56f2a0f65e12/embeddinggemma-300M-Q8_0.gguf",
};
/**
 * The longest input embedded, in UTF-8 bytes, prompt included: an input must fit Host's `--ubatch-size 2048`
 * (`embedder.test.ts` checks), and Gemma's tokenizer never makes more tokens than bytes (it falls back to bytes),
 * whatever the script. A cut by characters let some texts run past it, and the embedder refused their whole batch.
 */
const EMBEDDED_BYTES = 2040;

/** `input` cut to `EMBEDDED_BYTES`, never inside a character (`encodeInto` writes whole ones); the rest is not read. */
const inputOf = (input: string) =>
  input.slice(
    0,
    new TextEncoder().encodeInto(input, new Uint8Array(EMBEDDED_BYTES)).read
  );

/** The model card's prompts: a query and a passage are embedded differently. */
const PROMPTS = {
  passage: "title: none | text: ",
  query: "task: search result | query: ",
} as const;

export type Embedded = keyof typeof PROMPTS;

export interface Embedder {
  embed: (texts: string[], as: Embedded) => Promise<number[][]>;
  model: string;
}

const Answer = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()).length(EMBEDDER_DIMENSIONS),
      index: z.number(),
    })
  ),
});

const vectorsOf = (json: unknown) =>
  Answer.parse(json)
    .data.sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);

/**
 * Where Lifelog Host runs the embedder, on this Mac only (its `Host.embedderPort`, `embedder.test.ts` checks): the one
 * address lifelog's search and Life's memory both embed at, so no text leaves the Mac.
 */
export const EMBEDDER_URL = "http://127.0.0.1:47615";

/** The embedder at `url` (llama.cpp's OpenAI-shaped `/v1/embeddings`; `EMBEDDER_URL` but in tests); it throws when the embedder is down. */
export function embedderAt(url: string): Embedder {
  return {
    embed: async (texts, as) => {
      const res = await fetch(new URL("/v1/embeddings", url), {
        body: JSON.stringify({
          input: texts.map((t) => inputOf(PROMPTS[as] + t)),
          model: EMBEDDER_MODEL,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        throw new Error(`the embedder answered ${res.status}`);
      }
      const vectors = vectorsOf(await res.json());
      if (vectors.length !== texts.length) {
        throw new Error("the embedder lost a text");
      }
      return vectors;
    },
    model: EMBEDDER_MODEL,
  };
}

/** The key a text's vector is kept under: its model and its text. */
export const textHashOf = (model: string, text: string) =>
  digest("sha256", `${model}\n${text}`, 64);

/** A vector as it is stored: little-endian float32 bytes. */
export const bytesOf = (vector: readonly number[]) =>
  new Uint8Array(new Float32Array(vector).buffer);
export const vectorOf = (bytes: Uint8Array) =>
  bytes.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0
    ? new Float32Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / Float32Array.BYTES_PER_ELEMENT
      )
    : new Float32Array(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        )
      );

const BATCH = 32;
/** Every text embedded as a passage, one batch at a time (the embedder runs one at a time anyway). */
export async function embedAll(embedder: Embedder, texts: string[]) {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    // biome-ignore lint/performance/noAwaitInLoops: one batch at a time
    const batch = await embedder.embed(texts.slice(i, i + BATCH), "passage");
    vectors.push(...batch);
  }
  return vectors;
}

/** Items each ranking (meaning, words) hands to the fusion. */
export const CANDIDATES = 200;
/**
 * Below this cosine an item is too far in meaning to be a hit: on the owner's queries (5 Nov 2026) it kept 39 of the
 * bench's 40 right answers and dropped half the queries that had none.
 */
const MIN_SIMILARITY = 0.25;

function cosine(a: Float32Array, b: Float32Array) {
  let [dot, bb] = [0, 0];
  for (let i = 0; i < a.length; i += 1) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    dot += x * y;
    bb += y * y;
  }
  return dot / Math.sqrt(bb);
}

/** The ids nearest `query`: at least `MIN_SIMILARITY`, keeping only `CANDIDATES` scores in memory. */
export function nearest(
  query: readonly number[],
  items: Iterable<readonly [string, Float32Array]>
) {
  const length = Math.hypot(...query);
  const q = Float32Array.from(query, (n) => n / length);
  const best: { id: string; similarity: number }[] = [];
  for (const [id, vector] of items) {
    const similarity = cosine(q, vector);
    if (!(similarity >= MIN_SIMILARITY)) {
      continue;
    }
    const before = best.findIndex((b) => b.similarity < similarity);
    if (before < 0) {
      if (best.length < CANDIDATES) {
        best.push({ id, similarity });
      }
    } else {
      best.splice(before, 0, { id, similarity });
      if (best.length > CANDIDATES) {
        best.pop();
      }
    }
  }
  return best.map((b) => b.id);
}
