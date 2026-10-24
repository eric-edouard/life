// What the feed (GET /changes) carries, in commit order. Every writer of something the phone or a
// reader follows logs it here in the same transaction, so a reader of `seq` never skips a change.
// The feed loads the current row of each (kind, ref) it finds (feed.ts).

import type { Db } from "@lifelog/db";
import { changeLog, touchesJob } from "@lifelog/db/schema";
import { sql } from "drizzle-orm";

export type ChangeKind =
  | "assignment"
  | "chapter"
  | "conversation"
  | "edit"
  | "job"
  | "mac"
  | "person"
  | "quietRange"
  | "switches"
  | "turn"
  // The owner's words, carried whole on every page like the switches.
  | "vocabulary"
  // Unsent audio withdrawn (cutter.ts `withdrawRows`): `id:firstPage:sourceId`.
  | "withdrawn";

// A turn's ref, and the same built in SQL from a `turns t` row. The stored `turns_fp` hashes it
// (summaries.ts): a new format would re-run every summary.
export const turnRef = (jobId: string, turnIndex: number) =>
  `${jobId}:${turnIndex}`;
export const TURN_REF = sql`t.job_id || ':' || t.turn_index`;

// One process writes the file and a transaction runs to its end before anything else does, so
// `seq` order is commit order: a reader never passes a change it hasn't seen.
const CHUNK = 5000;

// Inside the writer's transaction, last in it by habit (the feed reads rows as they are then).
export function logChange(
  tx: Pick<Db, "insert">,
  kind: ChangeKind,
  refs: string | string[]
) {
  const values = [...new Set(Array.isArray(refs) ? refs : [refs])].map(
    (ref) => ({ kind, ref })
  );
  for (let i = 0; i < values.length; i += CHUNK) {
    tx.insert(changeLog)
      .values(values.slice(i, i + CHUNK))
      .run();
  }
}

// Logs every turn in one of `ranges` (epoch ms or Dates): what a conversation's range,
// a quiet range or a retirement changed for their conversation or a turn's text. The feed gives
// each its conversation (the server's placement, the one rule), so it is never stale.
export function logPlacedIn(
  tx: Pick<Db, "run">,
  ranges: [Date | number, Date | number][]
) {
  if (ranges.length === 0) {
    return;
  }
  const json = JSON.stringify(
    ranges.map(([from, to]) => [
      new Date(from).getTime(),
      new Date(to).getTime(),
    ])
  );
  tx.run(sql`
    insert into change_log (kind, ref, at)
    select distinct 'turn', ${TURN_REF}, ${Date.now()} from turns t
    join json_each(${json}) r
      on t.start_at < r.value ->> 1 and t.end_at > r.value ->> 0`);
}

export function latestSeq(db: Pick<Db, "all">) {
  const [row] = db.all<{ seq: number | null }>(
    sql`select max(seq) as seq from change_log`
  );
  return row?.seq ?? 0;
}

// The live conversations the changes logged after `since` touched, and the seq read through, for
// a pass that redoes only what changed (conversation-state.ts, rolling.ts, search.ts): each
// conversation logged, those a logged job's audio lies in (a turn's job, a job's speaker rows, the
// jobs a renamed person speaks in), and a logged chapter's.
// `since` null: nothing read yet, every conversation counts as touched (`ids` null).
export function touchedSince(
  db: Pick<Db, "all">,
  since: number | null
): { ids: string[] | null; through: number } {
  const through = latestSeq(db);
  if (since === null) {
    return { ids: null, through };
  }
  if (through <= since) {
    return { ids: [], through };
  }
  const rows = db.all<{ id: string }>(sql`
    with log as (
      select distinct kind, ref from change_log where seq > ${since} and seq <= ${through}),
    jobs as (
      select j.capture_start, j.capture_end from transcription_jobs j
      where j.id in (select ref from log where kind in ('job', 'assignment'))
        or j.id in (select substr(ref, 1, instr(ref, ':') - 1) from log where kind = 'turn')
        or j.id in (select a.job_id from speaker_assignments a
          join log on log.kind = 'person' and log.ref = a.person_id))
    select c.id from conversations c
    where c.retired_at is null and (
      c.id in (select ref from log where kind = 'conversation')
      or c.id in (select h.conversation_id from chapters h
        join log on log.kind = 'chapter' and log.ref = h.id)
      or exists (select 1 from jobs j where ${touchesJob()}))`);
  return { ids: rows.map((r) => r.id), through };
}
