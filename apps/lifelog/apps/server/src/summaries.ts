// What a conversation's summary is now: its runs as the feed and readers read them, and the
// `chapters` rows written from the latest valid one. Runs are made by intelligence.ts.

import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  chapters as chapterRows,
  holdsTurn,
  intelligenceRuns as runs,
  settled,
  type TurnRef,
} from "@lifelog/db/schema";
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { logChange, TURN_REF } from "./change-log";
import { uuidOf } from "./config";
import {
  renderSpeakers,
  type SpeakerToken,
  tokenNames,
} from "./speaker-tokens";
import { Result } from "./summary-calls";

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

// The latest valid run with its result read, speakers as tokens. Null without one.
export function latestValid(db: Db, conversationId: string) {
  const run = db.query.intelligenceRuns
    .findFirst({
      orderBy: desc(runs.createdAt),
      where: and(
        eq(runs.conversationId, conversationId),
        eq(runs.state, "valid")
      ),
    })
    .sync();
  const result = Result.safeParse(run?.result).data;
  return run && result ? { ...run, result } : null;
}

// A conversation's run text as it reads now: each speaker token with its voice's current name.
function rendererOf(
  db: Db,
  conversationId: string,
  tokens: SpeakerToken[] | undefined
) {
  const names = tokens?.length ? tokenNames(db, conversationId, tokens) : {};
  return (text: string) => renderSpeakers(text, names);
}

// How the conversation's latest valid run reads now (the feed renders its chapters with it).
export const rendererFor = (db: Db, conversationId: string) =>
  rendererOf(
    db,
    conversationId,
    latestValid(db, conversationId)?.result.speakerTokens
  );

// The latest valid run's result, with its id and the turns its ids index into, its speakers
// written with their current names. Null without one.
export function latestValidRun(db: Db, conversationId: string) {
  const run = latestValid(db, conversationId);
  if (!run) {
    return null;
  }
  const { id, result } = run;
  const render = rendererOf(db, conversationId, result.speakerTokens);
  return {
    id,
    result: {
      ...result,
      chapters: result.chapters.map((c) => ({
        ...c,
        summary: render(c.summary),
      })),
      tldr: { ...result.tldr, text: render(result.tldr.text) },
    },
    turns: run.turns,
  };
}

export const latestValidOutput = (db: Db, conversationId: string) =>
  latestValidRun(db, conversationId)?.result ?? null;

// The latest valid run's chapters as `chapters` rows. The id comes from the conversation and the
// chapter's start, so a chapter summarized again keeps it. Each ends where the next starts, the
// last where the turns after it start (still going on), else at the conversation's end. Rows no
// longer starting a chapter go. Only what changed is written and logged, a new run's chapters
// always; the conversation always (its title, TLDR and the names heard come with the run); `summarizedAt` is when a chapter was
// first summarized. Summaries keep their speaker tokens: the feed renders them.
export function writeChapters(db: Db, conversationId: string) {
  const valid = latestValid(db, conversationId);
  const conversation = db.query.conversations
    .findFirst({
      where: (c, { eq: is }) => is(c.id, conversationId),
    })
    .sync();
  const existing = db
    .select()
    .from(chapterRows)
    .where(eq(chapterRows.conversationId, conversationId))
    .all();
  if (!(valid && conversation)) {
    return;
  }
  const startOf = (turnId: number) => valid.turns[turnId]?.capturedAt ?? null;
  const { chapters } = valid.result;
  const rows = chapters.flatMap((c, i) => {
    const next = chapters[i + 1];
    const start = startOf(c.startTurnId);
    const end = next
      ? startOf(next.startTurnId)
      : (startOf(c.endTurnId + 1) ?? conversation.captureEndedAt.toISOString());
    if (!(start && end) || Date.parse(end) <= Date.parse(start)) {
      return [];
    }
    return {
      conversationId,
      endAt: new Date(end),
      id: uuidOf(`chapter|${conversationId}|${Date.parse(start)}`),
      runId: valid.id,
      startAt: new Date(start),
      summarizedAt: clock(),
      summary: c.summary,
      title: c.title,
    };
  });
  const before = new Map(existing.map((r) => [r.id, r]));
  const changed = rows.filter((r) => {
    const old = before.get(r.id);
    return !(
      old &&
      old.runId === r.runId &&
      old.title === r.title &&
      old.summary === r.summary &&
      old.startAt.getTime() === r.startAt.getTime() &&
      old.endAt.getTime() === r.endAt.getTime()
    );
  });
  const kept = new Set(rows.map((r) => r.id));
  const gone = existing.filter((r) => !kept.has(r.id)).map((r) => r.id);
  db.transaction((tx) => {
    if (gone.length > 0) {
      tx.delete(chapterRows).where(inArray(chapterRows.id, gone)).run();
    }
    if (changed.length > 0) {
      tx.insert(chapterRows)
        .values(changed)
        .onConflictDoUpdate({
          set: {
            endAt: sql`excluded.end_at`,
            runId: sql`excluded.run_id`,
            startAt: sql`excluded.start_at`,
            summarizedAt: sql`coalesce(${chapterRows.summarizedAt}, excluded.summarized_at)`,
            summary: sql`excluded.summary`,
            title: sql`excluded.title`,
          },
          target: chapterRows.id,
        })
        .run();
    }
    logChange(tx, "chapter", [...changed.map((r) => r.id), ...gone]);
    // Its title and TLDR roll up from the chapters.
    logChange(tx, "conversation", conversationId);
  });
}

// A run's boundaries of one confidence as instants: the start of the turn where a new conversation
// would begin. High ones are AI splits, medium ones are offered (feed.ts `splitSuggestions`).
export function splitsOf(
  result: Result | undefined,
  turns: TurnRef[],
  confidence: "high" | "medium"
) {
  return (result?.boundarySuggestions ?? []).flatMap((b) => {
    const at = Date.parse(turns[b.turnId]?.capturedAt ?? "");
    return b.kind === "split_at_turn" &&
      b.confidence === confidence &&
      Number.isFinite(at)
      ? [{ at }]
      : [];
  });
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
export const summaryDue = (db: Db) => dueWhere(db, null);

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
