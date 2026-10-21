import { Database } from "bun:sqlite";
import { join } from "node:path";
import { TEST } from "../truth";
import { OUT } from "./ledger";

// Search by meaning: lifelog's embedding model (OpenAI, the one API key the owner allowed, for embeddings only) over
// the index's texts, cached by text in derived/memory/embeddings.sqlite so a rebuild never embeds a text twice. With no
// key, or offline, nothing is embedded and search is keyword-only.

const MODEL = "text-embedding-3-large";
const DIMENSIONS = 1536;
const BATCH = 128;
const CACHE = join(OUT, "embeddings.sqlite");
const KEY = TEST ? undefined : process.env.OPENAI_API_KEY;
/** Reciprocal rank fusion's constant: a hit's score is Σ 1/(K + rank) over the lists it is in. */
const K = 60;

const hashOf = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** The cache, read and appended by every process; its vectors never change, so each process keeps the ones it read. */
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

/** The cached vectors of `texts`, by text; a text not embedded yet has none. */
export function vectorsOf(texts: string[]) {
  const missing = [...new Set(texts.map(hashOf))].filter((h) => !read.has(h));
  if (missing.length > 0) {
    const db = cache();
    try {
      const get = db.query<
        { hash: string; vector: Uint8Array },
        [string, string]
      >("select hash, vector from vectors where model = ? and hash = ?");
      for (const h of missing) {
        const row = get.get(MODEL, h);
        if (row) {
          read.set(h, new Float32Array(row.vector.slice().buffer));
        }
      }
    } finally {
      db.close();
    }
  }
  return new Map(
    texts.flatMap((t) => {
      const v = read.get(hashOf(t));
      return v ? [[t, v]] : [];
    })
  );
}

/** Embeds the texts not in the cache yet, a batch at a time; false when it can't (no key, offline), nothing thrown. */
export async function embed(texts: string[]) {
  const have = vectorsOf(texts);
  const todo = [...new Set(texts.filter((t) => t.trim() && !have.has(t)))];
  if (!KEY) {
    return todo.length === 0;
  }
  const db = cache();
  const put = db.prepare("insert or ignore into vectors values (?, ?, ?)");
  try {
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      // biome-ignore lint/performance/noAwaitInLoops: one paid request at a time
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        body: JSON.stringify({
          dimensions: DIMENSIONS,
          input: batch,
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
      for (const d of data) {
        put.run(
          MODEL,
          hashOf(batch[d.index] as string),
          new Uint8Array(new Float32Array(d.embedding).buffer)
        );
      }
    }
    return true;
  } catch (e) {
    console.error(`(not embedded: ${(e as Error).message})`);
    return false;
  } finally {
    db.close();
  }
}

/** The query's vector, embedded once per query text; null with no key or offline, so search falls back to words. */
export async function queryVector(q: string) {
  return (await embed([q])) ? (vectorsOf([q]).get(q) ?? null) : null;
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

/** The ids of the `n` items whose text is nearest `q` in meaning, nearest first; an item not embedded is left out. */
export function nearest(
  q: Float32Array,
  items: { id: string; text: string }[],
  n: number
) {
  const vectors = vectorsOf(items.map((i) => i.text));
  return items
    .flatMap((i) => {
      const v = vectors.get(i.text);
      return v ? [{ id: i.id, score: cosine(q, v) }] : [];
    })
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
