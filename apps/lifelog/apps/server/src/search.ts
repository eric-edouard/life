// Search by meaning. Each conversation's turns are cut into passages of about 30 to 60 s and embedded on the Mac
// (Life's core/embedder.ts, which Lifelog Host runs), then a query ranks them twice, by meaning and by the passages
// holding every word typed, and the two rankings are fused (Life's core/fusion.ts).
//
// - Indexing is a sweep: any conversation a change touched since the last sweep (its words, range,
//   speaker rows or people's names, by the change log) is rebuilt. A passage whose text is
//   unchanged keeps its embedding, so a rebuild only embeds what changed.
// - Nothing leaves the Mac: the embedder listens on loopback.
import {
  type Embedder,
  embedderAt,
  textHashOf,
} from "@life/server/src/core/embedder";
import { fuse } from "@life/server/src/core/fusion";
import type { Db } from "@lifelog/db";
import { float32, searchIndex, searchPassages } from "@lifelog/db/schema";
import { eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { touchedSince } from "./change-log";
import { type Config, SEARCH, singleFlight } from "./config";
import { type LoadedTurn, loadTurns } from "./transcript";

// Texts per request to the embedder.
const BATCH = 32;

async function embed(embedder: Embedder, texts: string[]) {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    // biome-ignore lint/performance/noAwaitInLoops: the embedder runs one batch at a time
    const batch = await embedder.embed(texts.slice(i, i + BATCH), "passage");
    vectors.push(...batch);
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
    textHash: textHashOf(embedder.model, p.text),
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
      embedder,
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
// indexed at) and every one not indexed yet; stops at the first failure (the embedder is likely
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
      // biome-ignore lint/performance/noAwaitInLoops: one conversation at a time
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
// Words of a query for the keyword ranking: runs of letters (with their marks, so a Thai word stays whole), digits
// and apostrophes, of 3 characters or more, the trigram index's least.
const WORDS = /[\p{L}\p{M}\p{N}']+/gu;

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

// Two rankings, fused: the passages nearest in meaning (at least SEARCH.minSimilarity), and those holding every word
// of 3 characters or more (the FTS5 trigram index, best match first; a query with no such word, the passages
// containing it as typed). Only passages embedded by `model` are compared.
function rank(db: Db, model: string, vector: number[], q: Query): Hit[] {
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
  // ponytail: the meaning ranking scans every passage's embedding in JS (~20k × 768 floats per query);
  // a vector index (sqlite-vec) when the archive outgrows that.
  const query = Float32Array.from(vector);
  const nearest = db
    .all<{ embedding: Uint8Array; id: string }>(
      sql`select p.id, p.embedding from search_passages p where ${filters} and p.model = ${model}`
    )
    .map((r) => [r.id, cosine(query, float32(r.embedding))] as const)
    .filter(([, similarity]) => similarity >= SEARCH.minSimilarity)
    .sort(([, a], [, b]) => b - a)
    .slice(0, SEARCH.candidates)
    .map(([id]) => id);
  const words = (q.text.match(WORDS) ?? []).filter((w) => [...w].length >= 3);
  const holding = (
    words.length > 0
      ? db.all<{ id: string }>(sql`select p.id from search_text
          join search_passages p on p.rowid = search_text.rowid
          where search_text match ${words.map((w) => `"${w.replaceAll('"', '""')}"`).join(" AND ")}
            and ${filters} and p.model = ${model}
          order by search_text.rank limit ${SEARCH.candidates}`)
      : db.all<{ id: string }>(sql`select p.id from search_passages p
          where ${filters} and p.model = ${model}
            and p.text like ${`%${q.text.replace(LIKE_SPECIAL, "\\$&")}%`} escape '\\'
          order by p.captured_from desc nulls last limit ${SEARCH.candidates}`)
  ).map((r) => r.id);
  const fused = fuse([nearest, holding]).slice(0, q.limit);
  const typed = q.text.toLowerCase();
  const { embedding: _, ...shown } = getTableColumns(searchPassages);
  const rows = new Map(
    db
      .select(shown)
      .from(searchPassages)
      .where(
        inArray(
          searchPassages.id,
          fused.map(([id]) => id)
        )
      )
      .all()
      .map((r) => [r.id, r])
  );
  return fused.flatMap(([id, score]) => {
    const r = rows.get(id);
    return r
      ? {
          capturedFrom: r.capturedFrom?.toISOString() ?? null,
          capturedTo: r.capturedTo?.toISOString() ?? null,
          conversationId: r.conversationId,
          exact: r.text.toLowerCase().includes(typed),
          firstTurn: r.firstTurn,
          jobId: r.jobId,
          languageCode: r.languageCode,
          lastTurn: r.lastTurn,
          passageId: r.id,
          score,
          speakers: r.speakers,
          text: r.text,
        }
      : [];
  });
}

// ---- Service ------------------------------------------------------------------

export interface Search {
  // Starts a sweep, or asks the running one to go again; never rejects.
  index: () => Promise<void>;
  // Null while the embedder is down.
  query: (q: Query) => Promise<Hit[] | null>;
}

// Null without EMBEDDER_URL (Lifelog Host always sets it): the app then searches with its own keyword index only (the
// routes answer search_unavailable).
export function searchFor(
  db: Db,
  config: Config,
  embedder: Embedder | null = config.EMBEDDER_URL
    ? embedderAt(config.EMBEDDER_URL)
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
  return {
    index: () =>
      sweep().catch((error: unknown) => console.error("search index:", error)),
    query: async (q) => {
      const vector = await embedder.embed([q.text], "query").then(
        ([v]) => v,
        (error: unknown) => console.error("search query:", error)
      );
      return vector ? rank(db, embedder.model, vector, q) : null;
    },
  };
}
