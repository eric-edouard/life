// A conversation's runs as the feed and readers read them. Runs are made by intelligence.ts; those
// of prompt version 11 and before also hold a summary (chapters, title, TLDR), read by
// `latestSummary`.

import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  holdsTurn,
  intelligenceRuns as runs,
  settled,
} from "@lifelog/db/schema";
import { and, desc, eq, inArray, lte, type SQL, sql } from "drizzle-orm";
import { TURN_REF } from "./change-log";
import { renderSpeakers, tokenNames } from "./speaker-tokens";
import { LAST_SUMMARY_VERSION, Result } from "./voices-call";

export type Run = typeof runs.$inferSelect;

// The latest run of the conversation newer than `after` (any, when null) that is valid, running or
// waiting: what makes the owner's Generate, sent when he saw `after`, already answered.
export const runAfter = (
  db: Db,
  conversationId: string,
  after: string | null
) =>
  db.query.intelligenceRuns
    .findFirst({
      orderBy: desc(runs.createdAt),
      where: and(
        eq(runs.conversationId, conversationId),
        inArray(runs.state, ["valid", "running", "waiting"]),
        after
          ? sql`${runs.createdAt} > coalesce((select r.created_at from intelligence_runs r where r.id = ${after}), 0)`
          : undefined
      ),
    })
    .sync();

export const latestRun = (db: Db, conversationId: string) =>
  db.query.intelligenceRuns
    .findFirst({
      orderBy: desc(runs.createdAt),
      where: eq(runs.conversationId, conversationId),
    })
    .sync();

// The latest valid run, of any prompt version, with its result read. Null without one.
export const latestValid = (db: Db, conversationId: string) =>
  validRun(db, conversationId);

// The latest valid run that holds a summary (prompt version 11 or before), which new runs
// don't replace: the feed's title and TLDR, and the text its tokens render in.
export const latestSummary = (db: Db, conversationId: string) =>
  validRun(db, conversationId, lte(runs.promptVersion, LAST_SUMMARY_VERSION));

function validRun(db: Db, conversationId: string, where?: SQL) {
  const run = db.query.intelligenceRuns
    .findFirst({
      orderBy: desc(runs.createdAt),
      where: and(
        eq(runs.conversationId, conversationId),
        eq(runs.state, "valid"),
        where
      ),
    })
    .sync();
  const result = Result.safeParse(run?.result).data;
  return run && result ? { ...run, result } : null;
}

// How the conversation's latest summary reads now: each speaker token with its voice's current
// name (the feed renders its chapters and TLDR with it).
export function rendererFor(db: Db, conversationId: string) {
  const tokens = latestSummary(db, conversationId)?.result.speakerTokens;
  const names = tokens?.length ? tokenNames(db, conversationId, tokens) : {};
  return (text: string) => renderSpeakers(text, names);
}

// ---- When a summary is due (rolling.ts) ----------------------------------------------------

// A conversation `c`'s words as a roll reads them: the keys of the turns starting in its range, in
// order, and whether it is still open, as md5 (a fingerprint, not a secret). SQLite has no md5, so
// it is hashed here, from the very string Postgres hashed: fingerprints kept before stay valid.
const TURNS_OF = sql`turns t where ${holdsTurn()}`;
const fingerprintOf = (open: boolean, refs: string | null) =>
  (open ? "open:" : "") +
  new Bun.CryptoHasher("md5").update(refs ?? "").digest("hex");

// The conversations `c` matching `where`: their fingerprint, the one kept (`turns_fp`), and
// whether they hold words.
const fingerprints = (db: Db, where: SQL) =>
  db
    .all<{
      id: string;
      kept: string | null;
      open: number;
      refs: string | null;
    }>(sql`
      select c.id, c.turns_fp as kept, not ${settled()} as open,
        (select group_concat(ref, ',') from (select ${TURN_REF} as ref from ${TURNS_OF}
          order by t.start_at, t.job_id, t.turn_index)) as refs
      from conversations c where ${where}`)
    .map((r) => ({
      fp: fingerprintOf(Boolean(r.open), r.refs),
      id: r.id,
      kept: r.kept,
      words: r.refs !== null,
    }));

const among = (ids: string[] | null) =>
  ids
    ? sql`and c.id in (select value from json_each(${JSON.stringify(ids)}))`
    : sql``;

// The one rule: a live conversation grouped here, of talk, with words that differ from what its
// last finished roll read (`turns_fp`), or that closed since; or any live one whose latest run
// waits (the Mac left, or the owner's Generate came while it was away). A condition on `c`; the
// fingerprints are taken now, of the conversations among `ids` (null: every one).
// ponytail: hashes every candidate's turn refs per call; keep a fingerprint per conversation,
// updated by the turn writers, if a pass gets slow.
function dueWhere(db: Db, ids: string[] | null) {
  const changed = fingerprints(
    db,
    sql`c.retired_at is null and c.kind = 'conversation' and c.source_id is not null ${among(ids)}`
  )
    .filter((r) => r.words && r.fp !== r.kept)
    .map((r) => r.id);
  return sql`(c.retired_at is null and (c.id in (select value from json_each(${JSON.stringify(changed)}))
    or (select r.state from intelligence_runs r where r.conversation_id = c.id
      order by r.created_at desc limit 1) = 'waiting'))`;
}
export const runDue = (db: Db) => dueWhere(db, null);

// A failed roll is tried again 5 minutes after it failed, then 10, 20, 40, then once an hour.
const backingOff = (
  now: number
) => sql`coalesce((select r.state = 'failed' and r.updated_at > ${now}
  - min(${5 * 60_000} * (1 << min((select count(*) - 1 from intelligence_runs f
      where f.conversation_id = c.id and f.state = 'failed'
        and f.created_at > coalesce((select max(o.created_at) from intelligence_runs o
          where o.conversation_id = c.id and o.state <> 'failed'), 0)), 4)),
    ${60 * 60_000})
  from intelligence_runs r where r.conversation_id = c.id
  order by r.created_at desc limit 1), 0)`;

// The due conversations among `ids` (null: every one), newest first; `later` while a failed roll
// backs off.
export function dueConversations(db: Db, ids: string[] | null) {
  if (ids?.length === 0) {
    return [];
  }
  return db
    .all<{ id: string; later: number }>(sql`
      select c.id, ${backingOff(clock().getTime())} as later from conversations c
      where ${dueWhere(db, ids)} ${among(ids)}
      order by c.capture_started_at desc`)
    .map((r) => ({ id: r.id, later: Boolean(r.later) }));
}

export const fingerprint = (db: Db, id: string) =>
  fingerprints(db, sql`c.id = ${id}`)[0]?.fp ?? null;
