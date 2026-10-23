// Search by meaning. Each conversation's turns are cut into passages of about 30 to 60 s,
// embedded with OpenAI, and ranked against a query by cosine similarity plus keyword
// similarity, with a boost for passages that contain the query as typed so exact names win.
//
// - Indexing is a sweep: any conversation a change touched since the last sweep (its words, range,
//   speaker rows or people's names, by the change log) is rebuilt. A passage whose text is
//   unchanged keeps its embedding, so a rebuild only pays for what changed.
// - Only passage text (speaker names and words) goes to OpenAI (docs/providers.md).
import { createHash } from "node:crypto";
import type { Db } from "@lifelog/db";
import {
  EMBEDDING_DIMENSIONS,
  embeddingCalls,
  float32,
  searchIndex,
  searchPassages,
} from "@lifelog/db/schema";
import { eq, getTableColumns, inArray, sql } from "drizzle-orm";
import OpenAI from "openai";
import { touchedSince } from "./change-log";
import {
  type Config,
  EMBEDDING_USD_PER_MTOK,
  SEARCH,
  singleFlight,
} from "./config";
import { switches } from "./switches";
import { type LoadedTurn, loadTurns } from "./transcript";

export interface Embedder {
  embed: (texts: string[]) => Promise<{ tokens: number; vectors: number[][] }>;
  model: string;
}

function openaiEmbedder(apiKey: string, model: string): Embedder {
  const client = new OpenAI({ apiKey });
  return {
    embed: async (input) => {
      const res = await client.embeddings.create({
        dimensions: EMBEDDING_DIMENSIONS,
        encoding_format: "float",
        input,
        model,
      });
      return {
        tokens: res.usage.total_tokens,
        vectors: res.data
          .sort((a, b) => a.index - b.index)
          .map((d) => d.embedding),
      };
    },
    model,
  };
}

// OpenAI accepts up to 2048 inputs per request; passages are small, so this stays far
// below its token limit too.
const BATCH = 128;

// Embeds in batches; each paid request is logged for spending.
async function embed(
  db: Db,
  embedder: Embedder,
  purpose: "index" | "query",
  texts: string[]
) {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    // biome-ignore lint/performance/noAwaitInLoops: one paid request at a time
    const res = await embedder.embed(texts.slice(i, i + BATCH));
    const price = EMBEDDING_USD_PER_MTOK[embedder.model];
    db.insert(embeddingCalls)
      .values({
        costUsd: price === undefined ? null : (res.tokens * price) / 1e6,
        model: embedder.model,
        purpose,
        tokens: res.tokens,
      })
      .run();
    vectors.push(...res.vectors);
  }
  return vectors;
}

// ---- Passages -----------------------------------------------------------------

export interface Passage {
  capturedFrom: Date | null;
  capturedTo: Date | null;
  firstTurn: number;
  jobId: string;
  languageCode: string;
  lastTurn: number;
  personIds: string[];
  speakers: string[];
  text: string;
}

const line = (t: LoadedTurn) =>
  t.person ? `${t.person.name}: ${t.text.trim()}` : t.text.trim();

// Consecutive turns of one part, closed once they span passageMinSeconds or hold
// passageChars, and never grown past passageMaxSeconds.
export function cutPassages(turns: LoadedTurn[]): Passage[] {
  const groups: LoadedTurn[][] = [];
  let open: LoadedTurn[] | null = null;
  for (const turn of turns.filter((t) => t.text.trim() !== "")) {
    const [first] = open ?? [];
    if (
      !(open && first) ||
      first.ref.jobId !== turn.ref.jobId ||
      turn.endSeconds - first.startSeconds > SEARCH.passageMaxSeconds
    ) {
      open = [];
      groups.push(open);
    }
    open.push(turn);
    const [head = turn] = open;
    if (
      turn.endSeconds - head.startSeconds >= SEARCH.passageMinSeconds ||
      open.map(line).join("\n").length >= SEARCH.passageChars
    ) {
      open = null;
    }
  }
  return groups.flatMap((group) => {
    const [first] = group;
    const last = group.at(-1);
    if (!(first && last)) {
      return [];
    }
    const people = group.flatMap((t) => (t.person ? [t.person] : []));
    return {
      capturedFrom: first.ref.capturedAt
        ? new Date(first.ref.capturedAt)
        : null,
      capturedTo: last.endedAt ? new Date(last.endedAt) : null,
      firstTurn: first.ref.turnIndex,
      jobId: first.ref.jobId,
      languageCode: first.languageCode,
      lastTurn: last.ref.turnIndex,
      personIds: [...new Set(people.map((p) => p.id))],
      speakers: [...new Set(people.map((p) => p.name))],
      text: group.map(line).join("\n"),
    };
  });
}

const textHash = (model: string, text: string) =>
  createHash("sha256").update(`${model}\n${text}`).digest("hex");

// Rebuilds one conversation's passages from its transcribed jobs, embedding only those whose
// text is new. `seq`: the change log read through before reading it, kept on its index row.
async function indexConversation(
  db: Db,
  embedder: Embedder,
  conversationId: string,
  seq: number
): Promise<{ embedded: number; passages: number }> {
  const loaded = loadTurns(db, conversationId);
  const passages = (loaded ? cutPassages(loaded.turns) : []).map((p) => ({
    ...p,
    textHash: textHash(embedder.model, p.text),
  }));
  const known = new Map(
    db
      .select({
        embedding: searchPassages.embedding,
        textHash: searchPassages.textHash,
      })
      .from(searchPassages)
      .where(eq(searchPassages.conversationId, conversationId))
      .all()
      .map((r) => [r.textHash, r.embedding])
  );
  const missing = [
    ...new Map(
      passages
        .filter((p) => !known.has(p.textHash))
        .map((p) => [p.textHash, p.text])
    ),
  ];
  if (missing.length > 0) {
    const vectors = await embed(
      db,
      embedder,
      "index",
      missing.map(([, text]) => text.slice(0, SEARCH.embedChars))
    );
    for (const [i, [hash]] of missing.entries()) {
      const vector = vectors[i];
      if (!vector) {
        throw new Error(`no embedding for passage ${i}`);
      }
      known.set(hash, vector);
    }
  }
  db.transaction((tx) => {
    tx.delete(searchPassages)
      .where(eq(searchPassages.conversationId, conversationId))
      .run();
    if (passages.length > 0) {
      tx.insert(searchPassages)
        .values(
          passages.map((p) => ({
            ...p,
            conversationId,
            embedding: known.get(p.textHash) ?? [],
            model: embedder.model,
          }))
        )
        .run();
    }
    const indexed = { indexedAt: new Date(), model: embedder.model, seq };
    tx.insert(searchIndex)
      .values({ ...indexed, conversationId })
      .onConflictDoUpdate({ set: indexed, target: searchIndex.conversationId })
      .run();
  });
  return { embedded: missing.length, passages: passages.length };
}

// Live conversations without an index row for this model: new, touched since (`indexStale`
// deletes their rows), or indexed with another model.
function staleConversations(db: Db, model: string, limit: number) {
  const rows = db.all<{ id: string }>(sql`
    select c.id from conversations c
    where c.retired_at is null and not exists (select 1 from search_index i
      where i.conversation_id = c.id and i.model = ${model})
    limit ${limit}`);
  return rows.map((r) => r.id);
}

// Indexes every conversation a change touched since `since` (null: from the latest seq any row was
// indexed at) and every one not indexed yet; stops at the first failure (the provider is likely
// down) and leaves the rest for the next sweep. Their rows are deleted first, in one statement, so
// a sweep cut off finds them again. First, passages of conversations that aren't live go: search is
// derived from live conversations only (a retirement deletes its own, this catches anything older).
// Returns the seq read through.
async function indexStale(db: Db, embedder: Embedder, since: number | null) {
  db.run(sql`
    delete from search_passages
    where not exists (select 1 from conversations c
      where c.id = search_passages.conversation_id and c.retired_at is null)`);
  db.run(sql`
    delete from search_index
    where not exists (select 1 from conversations c
      where c.id = search_index.conversation_id and c.retired_at is null)`);
  const [last] = db.all<{ seq: number | null }>(
    sql`select max(seq) as seq from search_index`
  );
  const from = since ?? last?.seq ?? null;
  const touched = touchedSince(db, from);
  if (touched.ids === null) {
    db.delete(searchIndex).run();
  } else if (touched.ids.length > 0) {
    db.delete(searchIndex)
      .where(inArray(searchIndex.conversationId, touched.ids))
      .run();
  }
  for (let round = 0; round < 100; round += 1) {
    const ids = staleConversations(db, embedder.model, 20);
    if (ids.length === 0) {
      break;
    }
    for (const id of ids) {
      // biome-ignore lint/performance/noAwaitInLoops: paid requests, one at a time
      await indexConversation(db, embedder, id, touched.through);
    }
  }
  return touched.through;
}

// ---- Query --------------------------------------------------------------------

export interface Query {
  from?: Date | undefined;
  limit: number;
  // Person ids: passages where one of them speaks.
  people?: string[] | undefined;
  text: string;
  to?: Date | undefined;
}

export interface Hit {
  capturedFrom: string | null;
  capturedTo: string | null;
  conversationId: string;
  // The passage contains the query as typed.
  exact: boolean;
  firstTurn: number;
  jobId: string;
  languageCode: string;
  lastTurn: number;
  passageId: string;
  score: number;
  speakers: string[];
  text: string;
}

const LIKE_SPECIAL = /[\\%_]/g;

// pg_trgm's trigrams of a text, in order: each run of letters and digits, lowercased, padded with
// two spaces before and one after.
const trigramsOf = (text: string) =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).flatMap((word) => {
    const chars = [" ", " ", ...word, " "];
    return chars.slice(2).map((_, i) => chars.slice(i, i + 3).join(""));
  });

// pg_trgm's word_similarity(query, text): the greatest similarity (shared over union) between the
// query's trigram set and the trigrams of any contiguous extent of the text's. Every extent that
// starts and ends on a shared trigram is tried, where pg_trgm narrows them greedily, so it can only
// come out at or above Postgres's figure.
export function wordSimilarity(query: string, text: string) {
  const wanted = new Set(trigramsOf(query));
  const trigrams = trigramsOf(text);
  return trigrams.reduce(
    (best, first, lower) =>
      wanted.has(first)
        ? extentsFrom(trigrams.slice(lower), wanted, best)
        : best,
    0
  );
}

// The best similarity of the extents that start at `trigrams[0]`, given `best` so far.
function extentsFrom(trigrams: string[], wanted: Set<string>, before: number) {
  let best = before;
  const seen = new Set<string>();
  let shared = 0;
  for (const trigram of trigrams) {
    const wants = wanted.has(trigram);
    if (!seen.has(trigram)) {
      seen.add(trigram);
      shared += wants ? 1 : 0;
    }
    if (wants) {
      best = Math.max(best, shared / (wanted.size + seen.size - shared));
    }
    // Longer extents can't do better.
    if (wanted.size / seen.size <= best) {
      break;
    }
  }
  return best;
}

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

// Candidates: the passages nearest in meaning, and those containing the query (the FTS5 trigram
// index; under 3 characters it has no trigram, so `like`). Each is scored: cosine similarity, plus
// keyword similarity, plus the boost when it contains the query as typed.
function rank(db: Db, vector: number[], q: Query): Hit[] {
  // A sweep that ran while the conversation was retired may have put its passages back.
  const conditions = [
    sql`not exists (select 1 from conversations r
      where r.id = p.conversation_id and r.retired_at is not null)`,
  ];
  if (q.from) {
    conditions.push(sql`p.captured_from >= ${q.from.getTime()}`);
  }
  if (q.to) {
    conditions.push(sql`p.captured_from < ${q.to.getTime()}`);
  }
  if (q.people?.length) {
    conditions.push(sql`exists (select 1 from json_each(p.person_ids)
      where value in (select value from json_each(${JSON.stringify(q.people)})))`);
  }
  const filters = sql.join(conditions, sql` and `);
  // ponytail: the vector leg scans every passage's embedding in JS (~10k × 1536 floats per query);
  // a vector index (sqlite-vec) when the archive outgrows that.
  const query = Float32Array.from(vector);
  const similarity = new Map(
    db
      .all<{ embedding: Uint8Array; id: string }>(
        sql`select p.id, p.embedding from search_passages p where ${filters}`
      )
      .map((r) => [r.id, cosine(query, float32(r.embedding))])
  );
  const nearest = [...similarity]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 200)
    .map(([id]) => id);
  const keyword =
    [...q.text].length >= 3
      ? sql`p.rowid in (select rowid from search_text
          where search_text match ${`"${q.text.replaceAll('"', '""')}"`})`
      : sql`p.text like ${`%${q.text.replace(LIKE_SPECIAL, "\\$&")}%`} escape '\\'`;
  const containing = db
    .all<{ id: string }>(sql`select p.id from search_passages p
      where ${filters} and ${keyword}
      order by p.captured_from desc nulls last limit 200`)
    .map((r) => r.id);
  const typed = q.text.toLowerCase();
  const { embedding: _, ...shown } = getTableColumns(searchPassages);
  return db
    .select(shown)
    .from(searchPassages)
    .where(
      inArray(searchPassages.id, [...new Set([...nearest, ...containing])])
    )
    .all()
    .map((r) => {
      const exact = r.text.toLowerCase().includes(typed);
      return {
        capturedFrom: r.capturedFrom?.toISOString() ?? null,
        capturedTo: r.capturedTo?.toISOString() ?? null,
        conversationId: r.conversationId,
        exact,
        firstTurn: r.firstTurn,
        jobId: r.jobId,
        languageCode: r.languageCode,
        lastTurn: r.lastTurn,
        passageId: r.id,
        score:
          (similarity.get(r.id) ?? 0) +
          SEARCH.lexicalWeight * wordSimilarity(q.text, r.text) +
          (exact ? SEARCH.exactBoost : 0),
        speakers: r.speakers,
        text: r.text,
      };
    })
    .filter((h) => h.score >= SEARCH.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, q.limit);
}

// ---- Service ------------------------------------------------------------------

export interface Search {
  // Starts a sweep, or asks the running one to go again; never rejects.
  index: () => Promise<void>;
  query: (q: Query) => Promise<Hit[]>;
}

// Null without an OpenAI key: the app then searches with its own keyword index only, as it does
// while the AI switch is off (the routes answer search_unavailable).
export function searchFor(
  db: Db,
  config: Config,
  embedder: Embedder | null = config.OPENAI_API_KEY
    ? openaiEmbedder(config.OPENAI_API_KEY, config.EMBEDDING_MODEL)
    : null
): Search | null {
  if (!embedder) {
    return null;
  }
  // The change log read through; null until the first sweep.
  let cursor: number | null = null;
  // A sweep runs again when asked during one.
  const sweep = singleFlight(async () => {
    cursor = await indexStale(db, embedder, cursor);
  });
  // Query embeddings by text, oldest first.
  const cache = new Map<string, { at: number; vector: number[] }>();
  const queryVector = async (text: string) => {
    const hit = cache.get(text);
    if (hit && Date.now() - hit.at < SEARCH.cacheMinutes * 60_000) {
      return hit.vector;
    }
    const [vector] = await embed(db, embedder, "query", [text]);
    if (!vector) {
      throw new Error("no query embedding");
    }
    cache.delete(text);
    cache.set(text, { at: Date.now(), vector });
    for (const key of cache.keys()) {
      if (cache.size <= SEARCH.cacheEntries) {
        break;
      }
      cache.delete(key);
    }
    return vector;
  };
  return {
    index: () => {
      // AI off: stale conversations stay stale until it is back on (routes/switches.ts sweeps).
      if (!switches().ai) {
        return Promise.resolve();
      }
      return sweep().catch((error: unknown) =>
        console.error("search index:", error)
      );
    },
    query: async (q) => rank(db, await queryVector(q.text), q),
  };
}
