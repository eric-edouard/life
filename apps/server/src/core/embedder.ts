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
 * The longest text embedded, in characters: Host gives each of llama-server's slots 2048 tokens, and the densest text
 * measured (digits, Chinese, Thai mixed with English) runs near a token a character. The rest of a text is not read.
 */
const EMBEDDED_CHARS = 1900;

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

/** The embedder at `url` (llama.cpp's OpenAI-shaped `/v1/embeddings`); it throws when the embedder is down. */
export function embedderAt(url: string): Embedder {
  return {
    embed: async (texts, as) => {
      const res = await fetch(new URL("/v1/embeddings", url), {
        body: JSON.stringify({
          input: texts.map((t) => PROMPTS[as] + t.slice(0, EMBEDDED_CHARS)),
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
  new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
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
  let [dot, aa, bb] = [0, 0, 0];
  for (let i = 0; i < a.length; i += 1) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return dot / Math.sqrt(aa * bb);
}

/**
 * The ids of `items` nearest `query` in meaning, best first: at least `MIN_SIMILARITY`, `CANDIDATES` at most.
 * ponytail: every item is scored in JS (about 25k × 768 floats is a few hundred ms); a vector index (sqlite-vec) when
 * an archive nears 250k.
 */
export function nearest(
  query: readonly number[],
  items: Iterable<readonly [string, Float32Array]>
) {
  const q = Float32Array.from(query);
  return [...items]
    .map(([id, v]) => [id, cosine(q, v)] as const)
    .filter(([, similarity]) => similarity >= MIN_SIMILARITY)
    .sort(([, a], [, b]) => b - a)
    .slice(0, CANDIDATES)
    .map(([id]) => id);
}
