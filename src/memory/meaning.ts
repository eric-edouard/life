import { Database } from "bun:sqlite";
import { join } from "node:path";
import { DATA, TEST } from "../truth";
import { digest, OUT } from "./ledger";

// Search by meaning: lifelog's embedding model (OpenAI, the one API key the owner allowed, for embeddings only) over
// the index's texts, cached by the text's hash in derived/memory/embeddings.sqlite so a rebuild never embeds a text
// twice. With no key, or offline, nothing is embedded and search is by words only.

const MODEL = "text-embedding-3-large";
const DIMENSIONS = 1536;
/** What a vector is cached under besides its text: another model or size never matches it. */
const SPACE = `${MODEL}:${DIMENSIONS}`;
const BATCH = 128;
/** At most this many texts a call (about 20 s): the first backfill spreads over the next rebuilds. */
const PER_CALL = 2000;
const MAX_CHARS = 8000;
const CACHE = join(TEST ? DATA : OUT, "embeddings.sqlite");
const KEY = TEST ? undefined : process.env.OPENAI_API_KEY;
/**
 * How near in meaning an item must be to be a hit: below it, a hit meaning alone finds is padding (the replay of 21 Oct:
 * the best item's median cosine was 0.39, items holding all the words 0.26; at 0.4 the index answers grow 1.3x, not 3.3x).
 */
const NEAR = 0.4;
/** Reciprocal rank fusion's constant: a hit's score is Σ 1/(K + rank) over the lists it is in. */
const K = 60;

/** What a text's vector is cached and found by. */
export const hashOf = (text: string) => digest("sha256", text, 64);

/**
 * The cache, read and appended by every process; a vector never changes, so each process keeps the ones it read.
 * ponytail: the whole corpus in memory (about 6 KB a text, 45 MB at 7,000 texts, Oct 2026); keep the vectors in the
 * index, or fewer dimensions, if that grows.
 */
const read = new Map<string, Float32Array>();
function cache() {
  const db = new Database(CACHE, { create: true });
  db.run("pragma busy_timeout = 5000");
  db.run("pragma journal_mode = wal");
  db.run(
    "create table if not exists vectors (model text, hash text, vector blob, primary key (model, hash))"
  );
  return db;
}

/** The cached vectors of these hashes; a text not embedded yet has none. */
export function vectorsOf(hashes: string[]) {
  const missing = [...new Set(hashes)].filter((h) => !read.has(h));
  if (missing.length > 0) {
    const db = cache();
    try {
      const get = db.query<{ vector: Uint8Array }, [string, string]>(
        "select vector from vectors where model = ? and hash = ?"
      );
      for (const h of missing) {
        const row = get.get(SPACE, h);
        if (row) {
          read.set(h, new Float32Array(row.vector.slice().buffer));
        }
      }
    } finally {
      db.close();
    }
  }
  return new Map(
    hashes.flatMap((h) => {
      const v = read.get(h);
      return v ? [[h, v]] : [];
    })
  );
}

/** Caches each text's vector. */
export function store(vectors: [string, number[]][]) {
  const db = cache();
  try {
    const put = db.prepare("insert or ignore into vectors values (?, ?, ?)");
    for (const [text, v] of vectors) {
      put.run(SPACE, hashOf(text), new Uint8Array(new Float32Array(v).buffer));
    }
  } finally {
    db.close();
  }
}

/** Embeds the texts not in the cache yet (`PER_CALL` at most), a batch at a time; false when it can't (no key, offline). */
export async function embed(texts: string[]) {
  try {
    const have = vectorsOf(texts.map(hashOf));
    const todo = [
      ...new Set(texts.filter((t) => t.trim() && !have.has(hashOf(t)))),
    ].slice(0, PER_CALL);
    if (!KEY) {
      return todo.length === 0;
    }
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      // biome-ignore lint/performance/noAwaitInLoops: one paid request at a time
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        body: JSON.stringify({
          dimensions: DIMENSIONS,
          // Within the model's input (8,191 tokens), so no text is refused and holds the backfill up.
          input: batch.map((t) => t.slice(0, MAX_CHARS)),
          model: MODEL,
        }),
        headers: {
          authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`embeddings: ${res.status} ${await res.text()}`);
      }
      const { data } = (await res.json()) as {
        data: { embedding: number[]; index: number }[];
      };
      store(data.map((d) => [batch[d.index] as string, d.embedding]));
    }
    return true;
  } catch (e) {
    console.error(`(not embedded: ${(e as Error).message})`);
    return false;
  }
}

let running: Promise<boolean> | null = null;
/**
 * Embeds the texts in the background, one run at a time (a call meanwhile is skipped: the next rebuild brings its texts
 * again), so a rebuild never waits on the network nor holds the lock for it; a command's process waits for it (`embedded`).
 */
export function embedSoon(texts: string[]) {
  if (!running) {
    running = embed(texts).finally(() => {
      running = null;
    });
  }
}

/** The background embed in flight, if any: a command waits for it before its process exits (cli.ts). */
export const embedded = () => running ?? Promise.resolve(true);

/** The query's vector, embedded once per query text; null with no key or offline, so search falls back to words. */
export async function queryVector(q: string) {
  await embed([q]);
  return vectorsOf([hashOf(q)]).get(hashOf(q)) ?? null;
}

const cosine = (a: Float32Array, b: Float32Array) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / Math.sqrt(na * nb);
};

/** The ids of the `n` items whose text (by its hash) is nearest `q` in meaning and `NEAR` it, nearest first; one not embedded is left out. */
export function nearest(
  q: Float32Array,
  items: { hash: string; id: string }[],
  n: number
) {
  const vectors = vectorsOf(items.map((i) => i.hash));
  return items
    .flatMap((i) => {
      const v = vectors.get(i.hash);
      return v ? [{ id: i.id, score: cosine(q, v) }] : [];
    })
    .filter((i) => i.score >= NEAR)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((i) => i.id);
}

/** Reciprocal rank fusion: the ids of every ranked list, best first by Σ 1/(K + rank). */
export function fuse(lists: string[][]) {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (K + rank + 1));
    });
  }
  return [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
