import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { clock } from "../core/clock";
import { readJson } from "../core/files";
import { digest } from "../core/hash";
import { log } from "../core/log";
import { LIFE_STATE_DIR } from "../core/paths";
import { openReadOnly, openWritable } from "../core/sqlite";
import { isTimeZone } from "../core/time-zone";
import { call, lifelogMissing } from "./lifelog-call";

// Recorded conversations from lifelog's change feed (GET /changes), read with the owner's device token
// (LIFELOG_TOKEN in .env). Reads only (the one read by POST is /search), except through `writeLifelog`: `forward` (his explicit corrections), `answerNamingQueue` (his voice answers) and `notifyPhone` (a push, `lifelog-push.ts`). The feed is a gap-free numeric cursor: `since=0` is the whole archive, then each
// page's `cursor`. Life folds every page into a small local store (derived/watch/lifelog.sqlite: the conversations, and
// for every turn only who spoke, when, and when the feed brought it, never its text; plus the hearing's marks) and builds
// units from that store.
// Only the watcher (apps/server/src/host/watch.ts) calls `poll`: a page folded in anywhere else would never be heard (eric-edouard/life#5).

const WAIT_MARGIN_S = 30;

export const WATCH = join(LIFE_STATE_DIR, "watch");

// The shapes Life reads from lifelog's API, each field as nullable or optional as lifelog's contract says
// (`apps/server/openapi.json` in lifelog; lifelog.test.ts checks it). Fields Life doesn't read (its chapters and
// summaries among them) are left out and ignored.
export const Page = z.object({
  conversations: z.array(
    z.object({
      // Settled (the contract's `closed`): grouping adds nothing more to it; late audio or an edit can reopen it.
      closed: z.boolean().nullish(),
      endAt: z.string(),
      id: z.string(),
      kind: z.string(),
      // A retired conversation has a successor, or none (lifelog dropped it, e.g. playback it transcribed by mistake).
      retired: z.object({ successorId: z.string().nullable() }).nullable(),
      startAt: z.string(),
      state: z.string(),
    })
  ),
  cursor: z.string(),
  // Each recording: `endedOnSilence` (null on older ones), its `state`, and the phone source and Pendant pages it is of.
  jobs: z.array(
    z.object({
      endedOnSilence: z.boolean().nullish(),
      id: z.string(),
      pages: z.array(z.array(z.number())).nullish(),
      sourceId: z.string().nullish(),
      state: z.string().nullish(),
    })
  ),
  more: z.boolean(),
  removed: z.array(
    z.object({
      firstPage: z.number().optional(),
      kind: z.string(),
      ref: z.string(),
      sourceId: z.string().optional(),
    })
  ),
  turns: z
    .array(
      z.object({
        // null while lifelog's server has not yet grouped the turn into a conversation; it is sent again once it has.
        conversationId: z.string().nullable(),
        endAt: z.string(),
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

/** A recorded turn: where its words are (`readTranscript(jobId)[turnIndex]`), when, and who lifelog says spoke. */
export interface LifelogTurn {
  at: string;
  /** When it ended, and when the feed first brought it; null on a turn stored before 20 Oct. */
  end: string | null;
  jobId: string;
  name: string | null;
  /** Lifelog says the owner spoke it. */
  owner: boolean;
  /** Lifelog's person, when it named the speaker (a person with no name is still someone). */
  personId: string | null;
  seen: string | null;
  turnIndex: number;
}

/** A recorded conversation with its turns, each with the span of the ask that starts at it (the hearing's marks). */
export interface LifelogConversation {
  /** lifelog has settled it (the contract's `closed`): grouping adds nothing more to it. */
  closed: boolean;
  endedAt: string;
  id: string;
  startedAt: string;
  turns: (LifelogTurn & { marks: string[] })[];
}

/**
 * What the status snapshot reads of lifelog's `GET /status`: the Pendant and the phone as the phone last reported them.
 * The contract leaves both objects untyped, so every field here may be absent or null.
 */
export const LifelogStatus = z.object({
  pendant: z
    .object({
      batteryPercent: z.number().nullish(),
      connection: z.string().nullish(),
      knownAt: z.string().nullish(),
      recording: z.string().nullish(),
      recordingKnownAt: z.string().nullish(),
    })
    .nullish(),
  phoneHeartbeat: z
    .object({
      backlog: z.object({ pages: z.number().nullish() }).nullish(),
      timeZone: z.string().nullish(),
    })
    .nullish(),
});
export const lifelogStatus = async () =>
  LifelogStatus.parse(await call("/status", 15));

/**
 * The phone's zone, from its newest heartbeat; null when lifelog is not set up or that heartbeat names no zone Intl
 * knows. Throws when lifelog can't be read.
 */
export async function readPhoneZone() {
  if (lifelogMissing()) {
    return null;
  }
  const beat = (await lifelogStatus()).phoneHeartbeat;
  return beat?.timeZone && isTimeZone(beat.timeZone) ? beat.timeZone : null;
}

/** The store's file in `dir` and its cursor's. */
export const storeFiles = (dir = WATCH) => ({
  cursor: join(dir, "cursor.json"),
  file: join(dir, "lifelog.sqlite"),
});

/** The columns added since the first stores: `openStore` adds the ones an older store lacks (`create table if not exists` adds none), and rows fill them as they come again. `closed`, and what `lifelog-speech.ts` reads of a recording. */
const ADDED_COLUMNS = [
  ["conversations", "closed", "integer"],
  ["transcription_jobs", "state", "text"],
  ["transcription_jobs", "source_id", "text"],
  ["transcription_jobs", "first_page", "integer"],
  ["transcription_jobs", "last_page", "integer"],
] as const;

/** The store and the cursor beside it. The cursor belongs to its store: a new store starts from the beginning. */
export function openStore(dir = WATCH) {
  mkdirSync(dir, { recursive: true });
  const { cursor, file } = storeFiles(dir);
  if (!existsSync(file)) {
    rmSync(cursor, { force: true });
  }
  // The watcher writes while the memory steps read.
  const db = openWritable(file);
  db.run(`create table if not exists conversations (
    id text primary key, start_at text not null, end_at text not null, kind text not null, state text not null,
    successor text);
  create table if not exists turns (
    job_id text not null, turn_index integer not null, conversation_id text not null, start_at text not null,
    person_id text, person_name text, is_owner integer not null default 0, end_at text, seen_at text,
    primary key (job_id, turn_index));
  create table if not exists transcription_jobs (id text primary key, ended_on_silence integer);
  create table if not exists marks (
    job_id text not null, turn_index integer not null, refs text not null, primary key (job_id, turn_index));
  create index if not exists turns_conversation on turns (conversation_id, start_at);
  create index if not exists turns_start on turns (start_at);
  drop table if exists jobs;`);
  // A store made before the label still has its `title text not null`; two processes may open it at once.
  try {
    db.run("alter table conversations drop column title");
  } catch (e) {
    if (!String(e).includes("no such column")) {
      throw e;
    }
  }
  // ponytail: an older store's `chapters` table is kept unwritten, so a rolled-back Life.app still finds its chapters (else
  // its sync would remove every chapter unit, all seen unsummarized); drop it once no rollback past this is possible.
  // ponytail: a one-time upgrade of older stores; delete it, and the drop above, once every install has run it.
  for (const [table, column, type] of ADDED_COLUMNS) {
    try {
      db.run(`alter table ${table} add column ${column} ${type}`);
    } catch (e) {
      if (!String(e).includes("duplicate column")) {
        throw e;
      }
    }
  }
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

/** The store opened read-only, for a reader that must not create or change it (the status snapshot). */
export const readStore = (dir = WATCH): Store => ({
  cursor: storeFiles(dir).cursor,
  db: openReadOnly(storeFiles(dir).file),
});

/** The newest speech turn the watcher folded in (null with no store yet): lifelog sends turns once transcribed, minutes after they were spoken. */
export const newestTurn = (dir = WATCH) =>
  existsSync(storeFiles(dir).file)
    ? withStore(
        (s) =>
          s.db
            .query<{ at: string | null }, []>(
              "select max(start_at) as at from turns"
            )
            .get()?.at ?? null,
        () => readStore(dir)
      )
    : null;

const DIGITS = /^\d+$/;

function readCursor(store: Store) {
  const cursor = readJson<{ cursor?: string }>(store.cursor)?.cursor;
  return cursor && DIGITS.test(cursor) ? cursor : "0";
}

/** A live conversation (`c`) of the kinds Life reads: not replaced or retired (see `successor`), not dictation or silence. */
export const LIVE =
  "c.successor is null and c.kind in ('conversation', 'imported')";
/** A transcript turn's ref, the `<job>:<turn>@<instant>` every reader cites. */
export const turnRef = (job: string, turn: number, at: string) =>
  `${job}:${turn}@${at}`;
const TURN_REF = /^([^:\s]+):(\d+)@\S+$/;
/** A turn ref's recording and turn, or null for any other id. */
export const parseTurnRef = (ref: string) => {
  const [, jobId, turn] = ref.match(TURN_REF) ?? [];
  return jobId ? { jobId, turnIndex: Number(turn) } : null;
};

/** A stored turn's owner flag, by recording and turn. */
const ownerRow = (store: Store) =>
  store.db.query<{ is_owner: number }, [string, number]>(
    "select is_owner from turns where job_id = ? and turn_index = ?"
  );

/** Whether lifelog credits this turn (a turn ref) to the owner now, as the feed last sent it. */
export const ownerSpoke = (store: Store, ref: string) => {
  const t = parseTurnRef(ref);
  return Boolean(t && ownerRow(store).get(t.jobId, t.turnIndex)?.is_owner);
};

/** The stored successor: null while live; "" when retired with none (lifelog dropped it), so `successor is null` stays "live". */
const successor = (c: { retired: { successorId: string | null } | null }) =>
  c.retired ? (c.retired.successorId ?? "") : null;

/** A stored conversation's or turn's start: where the units built from it begin. */
const storedStartOf = (db: Database) => ({
  conversation: (id: string) =>
    db
      .query<{ at: string }, [string]>(
        "select start_at as at from conversations where id = ?"
      )
      .get(id)?.at,
  turn: (job: string, index: number) =>
    db
      .query<{ at: string }, [string, number]>(
        "select start_at as at from turns where job_id = ? and turn_index = ?"
      )
      .get(job, index)?.at,
});

/** Deletes what the feed says went: a conversation or a turn (`<job>:<turn>`). Returns its stored start. */
function drop(db: Database, r: Page["removed"][number]) {
  if (r.kind === "conversation") {
    const at = storedStartOf(db).conversation(r.ref);
    db.run("delete from conversations where id = ?", [r.ref]);
    return at;
  }
  if (r.kind === "turn") {
    const cut = r.ref.lastIndexOf(":");
    const [job, index] = [r.ref.slice(0, cut), Number(r.ref.slice(cut + 1))];
    const at = storedStartOf(db).turn(job, index);
    db.run("delete from turns where job_id = ? and turn_index = ?", [
      job,
      index,
    ]);
    return at;
  }
}

/** A page's recordings as stored rows. A withdrawn one (a removed `job` with its first page) is kept, not dropped: its pages are not in until the phone sends them again (`lifelog-speech.ts`). */
const jobRowsOf = (page: Page) => [
  ...page.jobs.map((j) => [
    j.id,
    j.endedOnSilence ? 1 : 0,
    j.state ?? null,
    j.sourceId ?? null,
    j.pages?.[0]?.[0] ?? null,
    j.pages?.at(-1)?.[1] ?? null,
  ]),
  ...page.removed.flatMap((r) =>
    r.kind === "job" && r.firstPage !== undefined
      ? [[r.ref, 0, "withdrawn", r.sourceId ?? null, r.firstPage, null]]
      : []
  ),
];

/**
 * Folds one page into the store: whole rows replace the ones with the same key, `removed` ones go. Idempotent. A turn
 * keeps when it was first `seen`: when the hearing could first have heard it. Returns the earliest instant the page
 * touched (a row's start before and after it), where its units begin; null when it carried nothing units are built from.
 */
export function apply(store: Store, page: Page, seen = clock().toISOString()) {
  const { db } = store;
  const stored = storedStartOf(db);
  const starts: (string | undefined)[] = [];
  const conversation = db.prepare(
    `insert or replace into conversations (id, start_at, end_at, kind, state, successor, closed)
    values (?, ?, ?, ?, ?, ?, ?)`
  );
  const turn = db.prepare(
    `insert into turns (job_id, turn_index, conversation_id, start_at, person_id, person_name, is_owner, end_at, seen_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (job_id, turn_index) do update set
    conversation_id = excluded.conversation_id, start_at = excluded.start_at, person_id = excluded.person_id,
    person_name = excluded.person_name, is_owner = excluded.is_owner, end_at = excluded.end_at,
    seen_at = coalesce(turns.seen_at, excluded.seen_at)`
  );
  db.transaction(() => {
    for (const j of jobRowsOf(page)) {
      db.run(
        "insert or replace into transcription_jobs (id, ended_on_silence, state, source_id, first_page, last_page) values (?, ?, ?, ?, ?, ?)",
        j
      );
    }
    for (const c of page.conversations) {
      starts.push(stored.conversation(c.id), c.startAt);
      conversation.run(
        c.id,
        c.startAt,
        c.endAt,
        c.kind,
        c.state,
        successor(c),
        c.closed ? 1 : 0
      );
    }
    for (const t of page.turns) {
      starts.push(stored.turn(t.jobId, t.turnIndex), t.startAt);
      turn.run(
        t.jobId,
        t.turnIndex,
        t.conversationId,
        t.startAt,
        t.speaker.personId,
        t.speaker.personName,
        t.speaker.isOwner ? 1 : 0,
        t.endAt,
        seen
      );
    }
    for (const r of page.removed) {
      starts.push(drop(db, r));
    }
  })();
  // A removed row never stored built no unit: it touches nothing.
  const [earliest] = starts.filter((s): s is string => !!s).sort();
  return earliest ? new Date(earliest) : null;
}

/**
 * Reads one page of the feed after the saved cursor (holding the request up to `wait` seconds for news), folds it into
 * the store and saves its cursor. `touched`: where the units it changed begin (`apply`); `more`: ask again now.
 */
export async function poll(store: Store, wait: number) {
  const since = readCursor(store);
  const page = Page.parse(
    await call(`/changes?since=${since}&wait=${wait}`, wait + WAIT_MARGIN_S)
  );
  // Before the page is folded in. A turn lifelog re-sends is not news; one it only now marks as his (it identifies the
  // owner late) is. A new turn with no speaker at all may be his too (a low-confidence ask, apps/server/src/host/hear.ts).
  const stored = ownerRow(store);
  const owner = page.turns.filter((t) => {
    const row = stored.get(t.jobId, t.turnIndex);
    return t.speaker.isOwner
      ? !row?.is_owner
      : !(row || t.speaker.personId || t.speaker.personName);
  });
  const touched = apply(store, page);
  writeFileSync(store.cursor, `${JSON.stringify({ cursor: page.cursor })}\n`);
  return {
    cursor: page.cursor,
    more: page.more && page.cursor !== since,
    /** The turns that just became the owner's (new, or re-sent as his) or are new and unattributed: which conversation, and when. */
    owner: owner.map((t) => ({
      at: t.startAt,
      conversation: t.conversationId,
    })),
    touched,
  };
}

/** The turns first seen in the `seconds` before the newest one: what a restarted watcher hears again (apps/server/src/host/watch.ts). */
export const lastSeen = (store: Store, seconds: number) =>
  store.db
    .query<{ at: string; conversation: string }, [string]>(
      `select start_at as at, conversation_id as conversation from turns
      where seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ', (select max(seen_at) from turns), ?)`
    )
    .all(`-${seconds} seconds`);

export const nameOf = (
  personId: string | null,
  personName: string | null,
  byId: Map<string, string>
) => (personId && byId.get(personId)) || personName;

export interface LifelogTurnRow {
  conversation_id: string;
  end_at: string | null;
  is_owner: number;
  job_id: string;
  person_id: string | null;
  person_name: string | null;
  seen_at: string | null;
  start_at: string;
  turn_index: number;
}

/**
 * The live conversations still going at `since` or after it that have words (silent ones and the owner's dictation
 * have none), with their turns, oldest first, whatever their state (late audio can reopen one: its units stay). A
 * retired conversation is gone: its successor comes through the feed. `byId`: lifelog person id -> the name in the directory.
 */
export function readConversations(
  store: Store,
  since: Date,
  byId: Map<string, string> = new Map()
): LifelogConversation[] {
  const { db } = store;
  const live = `from conversations c where ${LIVE} and c.end_at >= ?`;
  const from = since.toISOString();
  const turns = Map.groupBy(
    db
      .query<LifelogTurnRow, [string]>(
        `select t.* from turns t where t.conversation_id in (select c.id ${live}) order by t.start_at, t.job_id, t.turn_index`
      )
      .all(from),
    (t) => t.conversation_id
  );
  // His spans ("hey Life" or "hey <agent>") by wake turn, kept while that turn is not someone else's (lifelog may name its speaker later).
  const marks = new Map(
    db
      .query<{ job_id: string; refs: string; turn_index: number }, []>(
        "select * from marks"
      )
      .all()
      .map((m) => [
        `${m.job_id}:${m.turn_index}`,
        JSON.parse(m.refs) as string[],
      ])
  );
  return db
    .query<
      {
        closed: number | null;
        end_at: string;
        id: string;
        start_at: string;
      },
      [string]
    >(`select c.* ${live} order by c.start_at`)
    .all(from)
    .flatMap((c) => {
      const said = (turns.get(c.id) ?? []).map((t) => {
        const turn = lifelogTurn(t, byId);
        const refs = marks.get(`${t.job_id}:${t.turn_index}`) ?? [];
        // A turn lifelog gave someone else, or a recording transcribed again (its wake ref no longer this turn's): no mark.
        const marked =
          whose(turn) !== "other" &&
          refs[0] === turnRef(t.job_id, t.turn_index, t.start_at);
        return { ...turn, marks: marked ? refs : [] };
      });
      return said.length > 0
        ? [
            {
              closed: c.closed === 1,
              endedAt: c.end_at,
              id: c.id,
              startedAt: c.start_at,
              turns: said,
            },
          ]
        : [];
    });
}

/** The ids of the live conversations: a stored chapter unit stays only while its conversation is one (`frozenUnits`). */
export const liveConversations = (store: Store) =>
  new Set(
    store.db
      .query<{ id: string }, []>(
        `select c.id from conversations c where ${LIVE}`
      )
      .all()
      .map((c) => c.id)
  );

/** The turns of a conversation between two instants (a unit's range; the whole conversation by default), in order. */
export function turnsBetween(
  store: Store,
  conversationId: string,
  start = "",
  end = "9999",
  byId: Map<string, string> = new Map()
): LifelogTurn[] {
  return store.db
    .query<LifelogTurnRow, [string, string, string]>(
      "select * from turns where conversation_id = ? and start_at >= ? and start_at < ? order by start_at, job_id, turn_index"
    )
    .all(conversationId, start, end)
    .map((t) => lifelogTurn(t, byId));
}

/** Who spoke a turn, as lifelog names them: its person id (the directory may move it later), else its name; null for him or nobody. */
export const authorOf = (t: LifelogTurn) =>
  t.owner ? null : (t.personId ?? t.name);

/** Whose a turn is, as lifelog has it: his, someone lifelog named (by id or name), or nobody's. */
export function whose(t: LifelogTurn): "me" | "unknown" | "other" {
  if (t.owner) {
    return "me";
  }
  return t.personId || t.name ? "other" : "unknown";
}

export const lifelogTurn = (t: LifelogTurnRow, byId: Map<string, string>) => ({
  at: t.start_at,
  end: t.end_at,
  jobId: t.job_id,
  name: nameOf(t.person_id, t.person_name, byId),
  owner: t.is_owner === 1,
  personId: t.person_id,
  seen: t.seen_at,
  turnIndex: t.turn_index,
});

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

/**
 * Where one turn is now: its conversation (lifelog may have moved it since it was cited) and how many turns come
 * before it there, for `fetch --from-turn`; null once lifelog dropped it.
 */
export function turnPlace(store: Store, jobId: string, turnIndex: number) {
  return store.db
    .query<{ conversation: string; offset: number }, [string, number]>(
      `select t.conversation_id as conversation, (select count(*) from turns o where o.conversation_id = t.conversation_id
        and (o.start_at, o.job_id, o.turn_index) < (t.start_at, t.job_id, t.turn_index)) as offset
        from turns t where t.job_id = ?1 and t.turn_index = ?2`
    )
    .get(jobId, turnIndex);
}

/** The people lifelog names in the store's turns: its person id and the name it gave. */
export function speakers(store: Store) {
  return store.db
    .query<{ id: string; name: string }, []>(
      "select distinct person_id as id, person_name as name from turns where person_id is not null and person_name is not null"
    )
    .all();
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

/** Where the owner was at `at`, an ISO instant: 0 or 1 stay. A day's stays: `visits` with its bounds (`dayRange`). */
export async function whereAt(at: string) {
  return Stays.parse(await call(`/where?at=${encodeURIComponent(at)}`));
}

type VisitsQuery = Record<string, string | number | undefined>;
/** The owner's stays, newest first, at most 200, within `from`/`to` (the whole history without them): all, or by place name or coordinates (none when lifelog's 404 says no place the phone named matches); given up after `timeoutS` (`call`'s default without it). */
export async function visits(q: VisitsQuery, timeoutS?: number) {
  const query = new URLSearchParams(
    Object.entries(q).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, `${v}`] as [string, string]]
    )
  );
  return Stays.parse(
    await call(`/visits?${query}`, timeoutS).catch((e: { status?: number }) =>
      e.status === 404 ? [] : Promise.reject(e)
    )
  );
}

/**
 * Replaces the spans (marks) the hearing found in a conversation from `from` on (a span grows as he goes on): each
 * the refs of its turns, its wake first. Only refs are kept: where and whose a wake is stays the turn's row.
 */
export function writeMarks(
  store: Store,
  conversation: string,
  from: string,
  marks: string[][]
) {
  const now = () =>
    store.db
      .query<{ refs: string }, [string, string]>(
        `select m.refs from marks m join turns t using (job_id, turn_index)
          where t.conversation_id = ? and t.start_at >= ? order by m.refs`
      )
      .all(conversation, from)
      .map((m) => m.refs)
      .join("\n");
  const before = now();
  store.db.transaction(() => {
    store.db.run(
      `delete from marks where (job_id, turn_index) in
        (select job_id, turn_index from turns where conversation_id = ? and start_at >= ?)`,
      [conversation, from]
    );
    for (const refs of marks) {
      const wake = parseTurnRef(refs[0] ?? "");
      if (wake) {
        store.db.run(
          "insert or replace into marks (job_id, turn_index, refs) values (?, ?, ?)",
          [wake.jobId, wake.turnIndex, JSON.stringify(refs)]
        );
      }
    }
  })();
  // Whether they changed: the units on disk carry marks, so only then do they need building again.
  return now() !== before;
}

const SPECIAL = new Set(["unknown", "media"]);
const seg = (v?: string) => encodeURIComponent(v ?? "");

/** What the owner's correction carries (the connector's `correct_memory` arguments). */
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

type Write = [method: string, path: string, body: unknown];
/** The corrections Life forwards to lifelog, the owner's explicit ones (its other writes are `notifyPhone` and `answerNamingQueue`, `lifelog-voices.ts`). Each names the fields it needs and the request it makes. */
const FORWARDS: Record<
  string,
  { needs: (keyof Fix)[]; request: (a: Fix) => Write }
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
      { editedAt: clock().toISOString(), title: a.title },
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
  return await writeLifelog(...f.request(a));
}

/** One write to lifelog, logged before and after. */
export async function writeLifelog(...[method, path, body]: Write) {
  log("lifelog.write", { body, method, path, phase: "before" });
  const after = await call(path, 60, body, method);
  log("lifelog.write", { after, method, path, phase: "after" });
  return after;
}
