import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  bytesOf,
  EMBEDDER_MODEL,
  EMBEDDER_URL,
  type Embedder,
  embedAll,
  embedderAt,
  nearest,
  textHashOf,
  vectorOf,
} from "../core/embedder";
import { openReadOnly } from "../core/sqlite";
import { VECTORS } from "./ledger";
import { listening } from "./sources";

// Search by meaning's vectors (derived/memory/vectors.sqlite): one per text, kept under its hash (`textHashOf`), so a
// text is embedded once whatever holds it and whatever rebuilds the index. Derived and safe to delete: the watcher
// embeds it all again (`embedNew`). Written outside the memory lock: it holds nothing of memory's.

/** A text search may rank by meaning, and when it happened (the newest are embedded first). */
export interface Searched {
  at: string;
  hash?: string;
  text: string;
}

/** The embedder, Lifelog Host's: none when Life reads no voice source (no Host), and search ranks by words alone. */
export const embedderNow = (): Embedder | null =>
  listening() ? embedderAt(EMBEDDER_URL) : null;

/** The query's vector, or the one line that says why the search ranks by words alone. */
export async function embedQuery(
  words: string,
  embedder = embedderNow()
): Promise<{ note?: string; vector?: number[] }> {
  if (!embedder) {
    return { note: "(by words only: no voice source, so no embedder)" };
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

const PARTITION_ROWS = 4096;
const SCHEMA =
  "create table if not exists vectors (hash text primary key, vector blob not null, partition integer not null)";

const normalizedOf = (vector: readonly number[]) => {
  const length = Math.hypot(...vector);
  if (
    !(length > 0 && Number.isFinite(length)) ||
    vector.some((v) => !Number.isFinite(v))
  ) {
    throw new Error("the embedder returned an invalid vector");
  }
  return vector.map((v) => v / length);
};

/** Existing hashes survive the derived cache's reshape; each conversion holds at most one partition. */
function prepareVectors(db: Database) {
  db.run(SCHEMA);
  const columns = db
    .query<{ name: string }, []>("pragma table_info(vectors)")
    .all();
  if (columns.some((c) => c.name === "partition")) {
    db.run(
      "create index if not exists vectors_partition on vectors(partition)"
    );
    return;
  }
  db.transaction(() => {
    db.run("alter table vectors add column partition integer");
    let after = 0;
    const write = db.prepare(
      "update vectors set vector = ?, partition = ? where rowid = ?"
    );
    const last =
      db
        .query<{ last: number }, []>(
          "select coalesce(max(rowid), 0) as last from vectors"
        )
        .get()?.last ?? 0;
    while (after < last) {
      const rows = db
        .query<{ rowid: number; vector: Uint8Array }, [number]>(
          `select rowid, vector from vectors where rowid > ? order by rowid limit ${PARTITION_ROWS}`
        )
        .all(after);
      if (rows.length === 0) {
        break;
      }
      for (const row of rows) {
        write.run(
          bytesOf(normalizedOf([...vectorOf(row.vector)])),
          Math.floor((row.rowid - 1) / PARTITION_ROWS),
          row.rowid
        );
        after = row.rowid;
      }
    }
  })();
  db.run("create index if not exists vectors_partition on vectors(partition)");
}

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
 * Embeds at most 256 missing texts, newest first; the next tick reselects new arrivals before the historical backlog.
 * A failed batch publishes nothing; its unchanged hashes are retried on the next tick.
 */
export async function embedNew(embedder: Embedder, texts: Searched[]) {
  const byHash = new Map<string, string>();
  for (const t of texts.toSorted((a, b) => b.at.localeCompare(a.at))) {
    const hash = t.hash ?? textHashOf(embedder.model, t.text);
    if (!byHash.has(hash)) {
      byHash.set(hash, t.text);
    }
  }
  const known = readKnown([...byHash.keys()]);
  const missing = [...byHash]
    .filter(([hash]) => !known.has(hash))
    .slice(0, WRITE_EVERY);
  // Complete the model-free cache conversion before requesting any new embeddings.
  mkdirSync(dirname(VECTORS), { recursive: true });
  const db = new Database(VECTORS, { create: true });
  db.run("pragma busy_timeout = 30000");
  db.run("pragma journal_mode = wal");
  try {
    prepareVectors(db);
    if (missing.length === 0) {
      return 0;
    }
    const vectors = await embedAll(
      embedder,
      missing.map(([, text]) => text)
    );
    const next =
      db
        .query<{ next: number }, []>(
          "select coalesce(max(rowid), 0) + 1 as next from vectors"
        )
        .get()?.next ?? 1;
    const insert = db.prepare("insert or ignore into vectors values (?, ?, ?)");
    db.transaction(() => {
      for (const [i, [hash]] of missing.entries()) {
        insert.run(
          hash,
          bytesOf(normalizedOf(vectors[i] ?? [])),
          Math.floor((next + i - 1) / PARTITION_ROWS)
        );
      }
    })();
  } finally {
    db.close(true);
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
    ).run(
      JSON.stringify(
        texts.map((t) => t.hash ?? textHashOf(embedder.model, t.text))
      )
    );
  } finally {
    db.close(true);
  }
}

/** The nearest ids, scanning hash-addressed partitions while retaining only the best candidates. */
export function readNearest(
  vector: number[] | undefined,
  items: () => ({ id: string; hash: string } | { id: string; text: string })[]
) {
  if (!(vector && existsSync(VECTORS))) {
    return [];
  }
  const idsOf = new Map<string, string[]>();
  for (const item of items()) {
    const hash =
      "hash" in item ? item.hash : textHashOf(EMBEDDER_MODEL, item.text);
    const ids = idsOf.get(hash) ?? [];
    ids.push(item.id);
    idsOf.set(hash, ids);
  }
  const db = openReadOnly(VECTORS);
  try {
    function* rows() {
      const hasPartitions = db
        .query<{ name: string }, []>("pragma table_info(vectors)")
        .all()
        .some((c) => c.name === "partition");
      // The old cache is readable before its next write reshapes it without re-embedding.
      const partition = hasPartitions
        ? "v.partition"
        : `(v.rowid - 1) / ${PARTITION_ROWS}`;
      const last =
        db
          .query<{ last: number }, []>(
            `select coalesce(max(${partition}), -1) as last from vectors v`
          )
          .get()?.last ?? -1;
      db.run("create temp table wanted (hash text primary key)");
      db.query("insert into wanted select value from json_each(?)").run(
        JSON.stringify([...idsOf.keys()])
      );
      const query = db.query<
        { rowid: number; hash: string; vector: Uint8Array },
        number[]
      >(
        `select v.rowid, v.hash, v.vector from vectors v cross join wanted w on w.hash = v.hash where ${hasPartitions ? "v.partition = ?" : "v.rowid > ? and v.rowid <= ?"} order by v.rowid`
      );
      for (let index = 0; index <= last; index += 1) {
        const part = query.all(
          ...(hasPartitions
            ? [index]
            : [index * PARTITION_ROWS, (index + 1) * PARTITION_ROWS])
        );
        for (const row of part) {
          const value = vectorOf(row.vector);
          for (const id of idsOf.get(row.hash) ?? []) {
            yield [id, value] as const;
          }
        }
      }
    }
    return nearest(vector, rows());
  } finally {
    db.close();
  }
}
