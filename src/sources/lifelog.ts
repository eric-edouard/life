import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { log } from "../log";
import { digest, readJson } from "../memory/ledger";
import { ROOT } from "../truth";

// Recorded conversations from lifelog's change feed (GET /changes), read with the owner's device token
// (LIFELOG_TOKEN in .env). Reads only (the one POST is /search), except `forward`: the owner's explicit corrections. The feed is a gap-free numeric cursor: `since=0` is the whole archive, then each
// page's `cursor`. Life folds every page into a small local store (derived/watch/lifelog.sqlite: conversations, chapter
// titles and summaries, and for every turn only who spoke and when, never its text) and builds units from that store.
// The watcher (src/watch.ts) and the nightly (`catchUp`) both go through `poll`: a turn the nightly folds in first is
// never heard by the watcher (eric-edouard/life#5).

const WAIT_MARGIN_S = 30;

export const WATCH = join(ROOT, "derived", "watch");

// The shapes Life reads from lifelog's API, each field as nullable or optional as lifelog's contract says
// (`apps/server/openapi.json` in lifelog; lifelog.test.ts checks it). Fields Life doesn't read are left out and ignored.
export const Page = z.object({
  chapters: z.array(
    z.object({
      conversationId: z.string(),
      endAt: z.string(),
      id: z.string(),
      startAt: z.string(),
      // Stored as "" until lifelog summarizes the chapter: its unit is dropped as `no-summary`.
      summary: z
        .string()
        .nullable()
        .transform((x) => x ?? ""),
      title: z
        .string()
        .nullable()
        .transform((x) => x ?? ""),
    })
  ),
  conversations: z.array(
    z.object({
      endAt: z.string(),
      id: z.string(),
      kind: z.string(),
      ownerTitle: z.string().nullable(),
      // A retired conversation has a successor, or none (lifelog dropped it, e.g. playback it transcribed by mistake).
      retired: z.object({ successorId: z.string().nullable() }).nullable(),
      startAt: z.string(),
      state: z.string(),
      title: z.string().nullable(),
    })
  ),
  cursor: z.string(),
  more: z.boolean(),
  removed: z.array(z.object({ kind: z.string(), ref: z.string() })),
  turns: z
    .array(
      z.object({
        // null while lifelog's server has not yet grouped the turn into a conversation; it is sent again once it has.
        conversationId: z.string().nullable(),
        jobId: z.string(),
        // Who spoke, as the server resolves it: a name given to one turn beats the voice's name.
        speaker: z.object({
          isOwner: z.boolean().default(false),
          personId: z.string().nullable(),
          personName: z.string().nullable(),
        }),
        startAt: z.string(),
        turnIndex: z.number(),
      })
    )
    .transform((ts) =>
      ts.filter(
        (t): t is typeof t & { conversationId: string } =>
          t.conversationId !== null
      )
    ),
});
type Page = z.infer<typeof Page>;

export interface LifelogChapter {
  end: string;
  id: string;
  /** Turns in it. */
  items: number;
  /** Names lifelog gave the people who speak in it. */
  people: string[];
  /** `jobId:turnIndex@startAt` of its first turn, the stable quote ref; absent when it has no turn. */
  ref?: string;
  start: string;
  summary: string;
  title: string;
}

export interface LifelogConversation {
  chapters: LifelogChapter[];
  endedAt: string;
  id: string;
  startedAt: string;
  state: string;
  title: string;
}

/** A turn of a chapter: where its words are (`readTranscript(jobId)[turnIndex]`), when, and who lifelog says spoke. */
export interface ChapterTurn {
  at: string;
  jobId: string;
  name: string | null;
  /** Lifelog says the owner spoke it. */
  owner: boolean;
  /** Lifelog's person, when it named the speaker (a person with no name is still someone). */
  personId: string | null;
  turnIndex: number;
}

/** lifelog's server (REST API). */
const lifelogUrl = () =>
  process.env.LIFELOG_URL ?? "https://lifelog.ericedouard.com";

function config() {
  const token = process.env.LIFELOG_TOKEN;
  if (!token) {
    throw new Error("LIFELOG_TOKEN is missing from .env");
  }
  return { token, url: lifelogUrl() };
}

/** GET `path`, or send `body` to it (POST unless `method` says otherwise). */
async function call(
  path: string,
  timeoutS = 60,
  body?: unknown,
  method = body === undefined ? "GET" : "POST"
) {
  const { url, token } = config();
  const res = await fetch(`${url}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    method,
    signal: AbortSignal.timeout(timeoutS * 1000),
  });
  if (!res.ok) {
    throw new Error(`lifelog ${method} ${path.split("?")[0]}: ${res.status}`);
  }
  return (await res.json()) as unknown;
}

/** The store's file in `dir` and its cursor's. */
export const storeFiles = (dir = WATCH) => ({
  cursor: join(dir, "cursor.json"),
  file: join(dir, "lifelog.sqlite"),
});

/** The store and the cursor beside it. The cursor belongs to its store: a new store starts from the beginning. */
export function openStore(dir = WATCH) {
  mkdirSync(dir, { recursive: true });
  const { cursor, file } = storeFiles(dir);
  if (!existsSync(file)) {
    rmSync(cursor, { force: true });
  }
  const db = new Database(file);
  db.run("pragma journal_mode = wal");
  // The watcher and the nightly may poll at the same time.
  db.run("pragma busy_timeout = 5000");
  db.run(`create table if not exists conversations (
    id text primary key, start_at text not null, end_at text not null, kind text not null, state text not null,
    title text not null, successor text);
  create table if not exists chapters (
    id text primary key, conversation_id text not null, start_at text not null, end_at text not null,
    title text not null, summary text not null);
  create table if not exists turns (
    job_id text not null, turn_index integer not null, conversation_id text not null, start_at text not null,
    person_id text, person_name text, is_owner integer not null default 0, primary key (job_id, turn_index));
  create index if not exists turns_conversation on turns (conversation_id, start_at);
  create index if not exists chapters_conversation on chapters (conversation_id);`);
  return { cursor, db };
}
export type Store = ReturnType<typeof openStore>;

/** `read` on the store, closed after. */
export async function withStore<T>(
  read: (store: Store) => T | Promise<T>,
  open = openStore
) {
  const store = open();
  try {
    return await read(store);
  } finally {
    store.db.close();
  }
}

const DIGITS = /^\d+$/;

export function readCursor(store: Store) {
  const cursor = readJson<{ cursor?: string }>(store.cursor)?.cursor;
  return cursor && DIGITS.test(cursor) ? cursor : "0";
}

/** A live conversation (`c`) of the kinds Life reads: not replaced or retired (see `successor`), not a note or a call. */
const LIVE = "c.successor is null and c.kind in ('conversation', 'imported')";
/** A transcript turn's ref, the `<job>:<turn>@<instant>` every reader cites. */
export const turnRef = (job: string, turn: number, at: string) =>
  `${job}:${turn}@${at}`;

/** The stored successor: null while live; "" when retired with none (lifelog dropped it), so `successor is null` stays "live". */
const successor = (c: { retired: { successorId: string | null } | null }) =>
  c.retired ? (c.retired.successorId ?? "") : null;

/** Folds one page into the store: whole rows replace the ones with the same key, `removed` ones go. Idempotent. */
export function apply(store: Store, page: Page) {
  const { db } = store;
  const conversation = db.prepare(
    "insert or replace into conversations values (?, ?, ?, ?, ?, ?, ?)"
  );
  const chapter = db.prepare(
    "insert or replace into chapters values (?, ?, ?, ?, ?, ?)"
  );
  const turn = db.prepare(
    "insert or replace into turns values (?, ?, ?, ?, ?, ?, ?)"
  );
  db.transaction(() => {
    for (const c of page.conversations) {
      conversation.run(
        c.id,
        c.startAt,
        c.endAt,
        c.kind,
        c.state,
        c.ownerTitle ?? c.title ?? "",
        successor(c)
      );
    }
    for (const c of page.chapters) {
      chapter.run(
        c.id,
        c.conversationId,
        c.startAt,
        c.endAt,
        c.title,
        c.summary
      );
    }
    for (const t of page.turns) {
      turn.run(
        t.jobId,
        t.turnIndex,
        t.conversationId,
        t.startAt,
        t.speaker.personId,
        t.speaker.personName,
        t.speaker.isOwner ? 1 : 0
      );
    }
    for (const r of page.removed) {
      if (r.kind === "chapter" || r.kind === "conversation") {
        db.run(`delete from ${r.kind}s where id = ?`, [r.ref]);
      } else if (r.kind === "turn") {
        const at = r.ref.lastIndexOf(":");
        db.run("delete from turns where job_id = ? and turn_index = ?", [
          r.ref.slice(0, at),
          Number(r.ref.slice(at + 1)),
        ]);
      }
    }
  })();
  return (
    page.conversations.length +
      page.chapters.length +
      page.turns.length +
      page.removed.length >
    0
  );
}

/**
 * Reads one page of the feed after the saved cursor (holding the request up to `wait` seconds for news), folds it into
 * the store and saves its cursor. `changed`: the page carried something units are built from; `more`: ask again now.
 */
export async function poll(store: Store, wait: number) {
  const since = readCursor(store);
  const page = Page.parse(
    await call(`/changes?since=${since}&wait=${wait}`, wait + WAIT_MARGIN_S)
  );
  // Before the page is folded in. A turn lifelog re-sends is not news; one it only now marks as his (it identifies the
  // owner late) is. A new turn with no speaker at all may be his too (a low-confidence ask, src/hear.ts).
  const stored = store.db.query<{ is_owner: number }, [string, number]>(
    "select is_owner from turns where job_id = ? and turn_index = ?"
  );
  const owner = page.turns.filter((t) => {
    const row = stored.get(t.jobId, t.turnIndex);
    return t.speaker.isOwner
      ? !row?.is_owner
      : !(row || t.speaker.personId || t.speaker.personName);
  });
  const changed = apply(store, page);
  writeFileSync(store.cursor, `${JSON.stringify({ cursor: page.cursor })}\n`);
  return {
    changed,
    cursor: page.cursor,
    more: page.more && page.cursor !== since,
    /** The turns that just became the owner's (new, or re-sent as his) or are new and unattributed: which conversation, and when. */
    owner: owner.map((t) => ({
      at: t.startAt,
      conversation: t.conversationId,
    })),
  };
}

/** Reads the feed to its end. Returns whether anything changed. */
export async function catchUp(store: Store) {
  let changed = false;
  for (let more = true; more; ) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential cursor paging
    const page = await poll(store, 0);
    changed ||= page.changed;
    ({ more } = page);
  }
  return changed;
}

const nameOf = (
  personId: string | null,
  personName: string | null,
  byId: Map<string, string>
) => (personId && byId.get(personId)) || personName;

interface TurnRow {
  conversation_id: string;
  is_owner: number;
  job_id: string;
  person_id: string | null;
  person_name: string | null;
  start_at: string;
  turn_index: number;
}

/**
 * The live conversations still going at `since` or after it (one that spans midnight keeps its chapters after) and have words to summarize (silent ones and the owner's
 * dictation have none), with their chapters, oldest first. A retired conversation is gone: its successor's chapters come
 * through the feed. `byId`: lifelog person id -> the name on the map.
 */
export function readConversations(
  store: Store,
  since: Date,
  byId: Map<string, string> = new Map()
): LifelogConversation[] {
  const { db } = store;
  if (!db.query("select 1 from conversations limit 1").get()) {
    throw new Error("the lifelog store is empty: run `bun life watch`");
  }
  const live = `from conversations c where ${LIVE} and c.end_at >= ?`;
  const from = since.toISOString();
  const turns = Map.groupBy(
    db
      .query<TurnRow, [string]>(
        `select t.* from turns t where t.conversation_id in (select c.id ${live}) order by t.start_at, t.job_id, t.turn_index`
      )
      .all(from),
    (t) => t.conversation_id
  );
  const chapters = Map.groupBy(
    db
      .query<
        {
          conversation_id: string;
          end_at: string;
          id: string;
          start_at: string;
          summary: string;
          title: string;
        },
        [string]
      >(
        `select h.* from chapters h where h.conversation_id in (select c.id ${live}) order by h.start_at`
      )
      .all(from)
      .map((c) => {
        const inside = (turns.get(c.conversation_id) ?? []).filter(
          (t) => t.start_at >= c.start_at && t.start_at < c.end_at
        );
        const [first] = inside;
        const chapter: LifelogChapter = {
          end: c.end_at,
          id: c.id,
          items: inside.length,
          people: [
            ...new Set(
              inside.flatMap((t) => {
                const n = nameOf(t.person_id, t.person_name, byId);
                return n ? [n] : [];
              })
            ),
          ],
          ...(first
            ? { ref: turnRef(first.job_id, first.turn_index, first.start_at) }
            : {}),
          start: c.start_at,
          summary: c.summary,
          title: c.title,
        };
        return { chapter, conversation: c.conversation_id };
      }),
    (c) => c.conversation
  );
  return db
    .query<
      {
        end_at: string;
        id: string;
        start_at: string;
        state: string;
        title: string;
      },
      [string]
    >(`select c.* ${live} order by c.start_at`)
    .all(from)
    .map((c) => ({
      chapters: (chapters.get(c.id) ?? []).map((h) => h.chapter),
      endedAt: c.end_at,
      id: c.id,
      startedAt: c.start_at,
      state: c.state,
      title: c.title,
    }));
}

/** The turns of a conversation between two instants (a chapter's range; the whole conversation by default), in order. */
export function turnsBetween(
  store: Store,
  conversationId: string,
  start = "",
  end = "9999",
  byId: Map<string, string> = new Map()
): ChapterTurn[] {
  return store.db
    .query<TurnRow, [string, string, string]>(
      "select * from turns where conversation_id = ? and start_at >= ? and start_at < ? order by start_at, job_id, turn_index"
    )
    .all(conversationId, start, end)
    .map((t) => ({
      at: t.start_at,
      jobId: t.job_id,
      name: nameOf(t.person_id, t.person_name, byId),
      owner: t.is_owner === 1,
      personId: t.person_id,
      turnIndex: t.turn_index,
    }));
}

export const Transcript = z.object({
  turns: z.array(
    z.object({
      speakerId: z.string().nullable().default(null),
      text: z.string(),
    })
  ),
});

/** One recording's transcript turns, in order (a turn ref's `turnIndex` indexes this list). Read-only. */
export async function readTranscript(jobId: string) {
  return Transcript.parse(
    await call(`/transcription-jobs/${encodeURIComponent(jobId)}/transcript`)
  ).turns;
}

/** How many turns of a conversation come before one turn: its place in the conversation, for `fetch --from-turn`. */
export function turnOffset(
  store: Store,
  conversationId: string,
  jobId: string,
  turnIndex: number
) {
  return (
    store.db
      .query<{ n: number }, [string, string, number]>(
        `select count(*) as n from turns where conversation_id = ?1
          and (start_at, job_id, turn_index) < (select start_at, job_id, turn_index from turns where job_id = ?2 and turn_index = ?3)`
      )
      .get(conversationId, jobId, turnIndex)?.n ?? 0
  );
}

/** The people lifelog names in the store's turns: its person id and the name it gave. */
export function speakers(store: Store) {
  return store.db
    .query<{ id: string; name: string }, []>(
      "select distinct person_id as id, person_name as name from turns where person_id is not null and person_name is not null"
    )
    .all();
}

/** The latest live conversations where lifelog's person (or one of the people) `personIds` spoke, newest first. */
export function conversationsWith(
  store: Store,
  personIds: string[],
  limit: number
) {
  return store.db
    .query<{ id: string; start_at: string; title: string }, [string, number]>(
      `select c.id, c.start_at, c.title from conversations c
        where ${LIVE}
          and c.id in (select conversation_id from turns where person_id in (select value from json_each(?)))
        order by c.start_at desc limit ?`
    )
    .all(JSON.stringify(personIds), limit);
}

export const Hits = z.object({
  hits: z.array(
    z.object({
      capturedFrom: z.string().nullable(),
      conversationId: z.string(),
      firstTurn: z.number(),
      jobId: z.string(),
      speakers: z.array(z.string()),
      text: z.string(),
    })
  ),
});

/** lifelog's search of the exact spoken words, best first. `from` is inclusive, `to` exclusive (ISO instants). */
export async function searchVoice(
  query: string,
  range: { from?: string; to?: string } = {},
  limit = 20
) {
  return Hits.parse(
    await call("/search", 60, {
      dateRange: range,
      limit,
      query,
    })
  ).hits;
}

export const Stays = z.array(
  z.object({
    arrivedAt: z.string(),
    latitude: z.number(),
    leftAt: z.string().nullable(),
    longitude: z.number(),
    place: z.string().nullish(),
  })
);
export type Stay = z.infer<typeof Stays>[number];

/** Where the owner was: `at` an ISO instant (0 or 1 stay) or a YYYY-MM-DD date (that day's stays). */
export async function whereAt(at: string) {
  return Stays.parse(await call(`/where?at=${encodeURIComponent(at)}`));
}

/** The owner's stays over the whole history, newest first, at most 200: by place name or by coordinates, within `from`/`to`. */
export async function visits(q: Record<string, string | number | undefined>) {
  const query = new URLSearchParams(
    Object.entries(q).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, `${v}`] as [string, string]]
    )
  );
  return Stays.parse(await call(`/visits?${query}`));
}

/** The live conversations that overlap [from, to): id, start and title. */
export function conversationsBetween(store: Store, from: string, to: string) {
  return store.db
    .query<{ id: string; start_at: string; title: string }, [string, string]>(
      `select id, start_at, title from conversations c
        where ${LIVE} and c.start_at < ?1 and c.end_at > ?2
        order by start_at`
    )
    .all(to, from);
}

const SPECIAL = new Set(["unknown", "media"]);
const seg = (v?: string) => encodeURIComponent(v ?? "");

/** What the owner's correction carries (the connector's `correct` arguments). */
export const Fix = z.object({
  aliases: z.array(z.string()).max(20).optional(),
  id: z
    .string()
    .optional()
    .describe(
      "title: a conversation id; rename_person, merge_people: a lifelog person id"
    ),
  jobId: z.string().optional().describe("speaker: the recording's id"),
  label: z.string().optional().describe("speaker: the voice's label"),
  name: z.string().optional().describe("rename_person: the new name"),
  newName: z.string().optional().describe("speaker: a new person's name"),
  personId: z
    .string()
    .optional()
    .describe("merge_people: the person folded into `id`, then deleted"),
  title: z
    .string()
    .nullable()
    .optional()
    .describe("title: the new title, or null to clear it"),
  to: z
    .string()
    .optional()
    .describe('speaker: a lifelog person id, "unknown" or "media"'),
  turnIndex: z
    .int()
    .min(0)
    .optional()
    .describe("speaker: only this turn, not the whole voice"),
});
type Fix = z.infer<typeof Fix>;

/**
 * Who a voice is, as lifelog takes it: a person, "unknown" or "media", or a new person. The new person's id is ours and
 * comes from the voice and the name (a v5-shaped UUID, as lifelog wants), so a replay makes nobody twice.
 */
function speakerTarget(a: Fix) {
  if (a.to) {
    return SPECIAL.has(a.to)
      ? { kind: a.to }
      : { kind: "person", personId: a.to };
  }
  if (a.newName) {
    const h = digest("sha1", `${a.jobId}|${a.label}|${a.newName}`, 32);
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20)}`;
    return { id, kind: "new", name: a.newName };
  }
  throw new Error("speaker needs: to or newName");
}

/** The only writes Life forwards to lifelog: the owner's explicit corrections. Each names the fields it needs and the request it makes. */
const FORWARDS: Record<
  string,
  { needs: (keyof Fix)[]; request: (a: Fix) => [string, string, unknown] }
> = {
  merge_people: {
    needs: ["id", "personId"],
    request: (a) => [
      "POST",
      `/people/${seg(a.id)}/merge`,
      { personId: a.personId },
    ],
  },
  rename_person: {
    needs: ["id"],
    request: (a) => [
      "PATCH",
      `/people/${seg(a.id)}`,
      { aliases: a.aliases, name: a.name },
    ],
  },
  speaker: {
    needs: ["jobId", "label"],
    request: (a) => [
      "PUT",
      `/transcripts/${seg(a.jobId)}/speakers/${seg(a.label)}`,
      { target: speakerTarget(a), turnIndex: a.turnIndex },
    ],
  },
  title: {
    needs: ["id", "title"],
    request: (a) => [
      "PUT",
      `/conversations/${seg(a.id)}/title`,
      { editedAt: new Date().toISOString(), title: a.title },
    ],
  },
};
export const FORWARD_KINDS = Object.keys(FORWARDS);

/** Sends one correction the owner approved, logging the request before it and the answer after it. */
export async function forward(kind: string, a: Fix) {
  const f = FORWARDS[kind];
  if (!f) {
    throw new Error(`not a forwardable correction: ${kind}`);
  }
  const missing = f.needs.filter((k) => a[k] === undefined);
  if (missing.length > 0) {
    throw new Error(`${kind} needs: ${missing.join(", ")}`);
  }
  const [method, path, body] = f.request(a);
  log("lifelog.write", { body, method, path, phase: "before" });
  const after = await call(path, 60, body, method);
  log("lifelog.write", { after, method, path, phase: "after" });
  return after;
}
