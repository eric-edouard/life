import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  bytesOf,
  EMBEDDER_MODEL,
  type Embedder,
  embedAll,
  embedderAt,
  nearest,
  textHashOf,
  vectorOf,
} from "../core/embedder";
import { settings } from "../core/settings";
import { openReadOnly } from "../core/sqlite";
import { VECTORS } from "./ledger";

// Search by meaning's vectors (derived/memory/vectors.sqlite): one per text, kept under its hash (`textHashOf`), so a
// text is embedded once whatever holds it and whatever rebuilds the index. Derived and safe to delete: the watcher
// embeds it all again (`embedNew`). Written outside the memory lock: it holds nothing of memory's.

/** A text search may rank by meaning, and when it happened (the newest are embedded first). */
export interface Searched {
  at: string;
  text: string;
}

/** The embedder he set (`embedder`), or null: search then ranks by words alone. */
export const embedderNow = (): Embedder | null => {
  const url = settings().embedder?.url;
  return url ? embedderAt(url) : null;
};

/** The query's vector, or the one line that says why the search ranks by words alone. */
export async function embedQuery(
  words: string
): Promise<{ note?: string; vector?: number[] }> {
  const embedder = embedderNow();
  if (!embedder) {
    return { note: "(by words only: no embedder set)" };
  }
  try {
    const [vector] = await embedder.embed([words], "query");
    return { vector };
  } catch (e) {
    return {
      note: `(by words only: the embedder is down: ${(e as Error).message})`,
    };
  }
}

const SCHEMA =
  "create table if not exists vectors (hash text primary key, vector blob not null)";

/** The hashes among `hashes` that have a vector. */
function readKnown(hashes: string[]) {
  if (!existsSync(VECTORS)) {
    return new Set<string>();
  }
  const db = openReadOnly(VECTORS);
  try {
    return new Set(
      db
        .query<{ hash: string }, [string]>(
          "select hash from vectors where hash in (select value from json_each(?))"
        )
        .all(JSON.stringify(hashes))
        .map((r) => r.hash)
    );
  } finally {
    db.close();
  }
}

/** How many texts it embeds before writing them. */
const WRITE_EVERY = 256;

/**
 * Embeds the texts that have no vector yet, newest first, writing as it goes; how many it embedded. A part the embedder
 * refuses is skipped, so it never holds back the older ones, and said at the end.
 */
export async function embedNew(embedder: Embedder, texts: Searched[]) {
  const byHash = new Map(
    texts
      .toSorted((a, b) => b.at.localeCompare(a.at))
      .map((t) => [textHashOf(embedder.model, t.text), t.text])
  );
  const known = readKnown([...byHash.keys()]);
  const missing = [...byHash].filter(([hash]) => !known.has(hash));
  if (missing.length === 0) {
    return 0;
  }
  mkdirSync(dirname(VECTORS), { recursive: true });
  const db = new Database(VECTORS, { create: true });
  db.run("pragma busy_timeout = 30000");
  db.run("pragma journal_mode = wal");
  db.run(SCHEMA);
  const insert = db.prepare("insert or ignore into vectors values (?, ?)");
  const failed: string[] = [];
  let inARow = 0;
  try {
    // Two refused parts in a row: the embedder is down, the next run tries again.
    for (let i = 0; i < missing.length && inARow < 2; i += WRITE_EVERY) {
      const part = missing.slice(i, i + WRITE_EVERY);
      // biome-ignore lint/performance/noAwaitInLoops: each part is written before the next is embedded
      const vectors = await embedAll(
        embedder,
        part.map(([, text]) => text)
      ).catch((e: Error) => {
        failed.push(e.message);
        return null;
      });
      inARow = vectors ? 0 : inARow + 1;
      db.transaction(() => {
        for (const [j, [hash]] of vectors ? part.entries() : []) {
          insert.run(hash, bytesOf(vectors?.[j] ?? []));
        }
      })();
    }
  } finally {
    db.close(true);
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length} parts not embedded: ${failed[0]}`);
  }
  return missing.length;
}

/** Drops the vectors of texts no longer searched (a passage that grew, a message past its window). */
export function pruneVectors(embedder: Embedder, texts: Searched[]) {
  if (!existsSync(VECTORS)) {
    return;
  }
  const db = new Database(VECTORS);
  db.run("pragma busy_timeout = 30000");
  try {
    db.query(
      "delete from vectors where hash not in (select value from json_each(?))"
    ).run(JSON.stringify(texts.map((t) => textHashOf(embedder.model, t.text))));
  } finally {
    db.close(true);
  }
}

/**
 * The ids of `items` nearest `vector` in meaning, best first (`nearest`); none without a vector or before any is embedded.
 * `items` is read only when there is a vector.
 * ponytail: hashes every item per search (~25k sha256, tens of ms); keep a hash column on the rows if that shows up.
 */
export function readNearest(
  vector: number[] | undefined,
  items: () => { id: string; text: string }[]
) {
  if (!(vector && existsSync(VECTORS))) {
    return [];
  }
  const hashOf = new Map(
    items().map((i) => [i.id, textHashOf(EMBEDDER_MODEL, i.text)])
  );
  const db = openReadOnly(VECTORS);
  try {
    const stored = new Map(
      db
        .query<{ hash: string; vector: Uint8Array }, [string]>(
          "select hash, vector from vectors where hash in (select value from json_each(?))"
        )
        .all(JSON.stringify([...new Set(hashOf.values())]))
        .map((r) => [r.hash, vectorOf(r.vector)])
    );
    return nearest(
      vector,
      [...hashOf].flatMap(([id, hash]) => {
        const v = stored.get(hash);
        return v ? [[id, v] as const] : [];
      })
    );
  } finally {
    db.close();
  }
}
