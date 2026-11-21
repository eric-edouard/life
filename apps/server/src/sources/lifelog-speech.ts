import {
  CONVERSATION_ENDS_AFTER,
  RECORDING_ENDS_ON_SILENCE_AFTER,
} from "../core/quiet";
import { LIVE, OVERLAPS, type Store, turnRef } from "./lifelog";

// Whether the words of a stretch of speech are in, by lifelog's own signals and spans (the contract's `endedOnSilence`
// and `closed`, the states and pages of its recordings), never a timing rule of Life's: the hearing (`host/hear.ts`)
// and the desk's calls (`host/events.ts`, `desk/desk-clock.ts`) both ask here.

/** Whether lifelog says nobody spoke for `RECORDING_ENDS_ON_SILENCE_AFTER` after a recording (the contract's `endedOnSilence`). */
export const endedOnSilence = (store: Store, jobId: string) =>
  store.db
    .query<{ ended_on_silence: number | null }, [string]>(
      "select ended_on_silence from transcription_jobs where id = ?"
    )
    .get(jobId)?.ended_on_silence === 1;

/** Whether lifelog has settled a conversation (the contract's `closed`). */
export const isConversationClosed = (store: Store, conversation: string) =>
  store.db
    .query<{ closed: number | null }, [string]>(
      "select closed from conversations where id = ?"
    )
    .get(conversation)?.closed === 1;

/**
 * Whether speech after turn `turn` is complete by lifelog's own signals: its recording ended on silence, or its
 * conversation is settled. Else the next recording may go on with it.
 */
export const isSettledAfter = (
  store: Store,
  turn: { conversation: string; jobId: string }
) =>
  endedOnSilence(store, turn.jobId) ||
  isConversationClosed(store, turn.conversation);

interface InsideRow {
  closed: number | null;
  conversation: string;
  conversation_end: string;
  first_page: number | null;
  job_id: string;
  recording_end: string;
  source_id: string | null;
  start_at: string;
  turn_index: number;
}

/**
 * The recordings of speech from `from` to `to` (ISO instants, `to` exclusive) once their words are in, else null: one
 * entry per conversation holding turns that overlap the span (`OVERLAPS`, as `fetch` cut to it reads them), `turn` the
 * ref of its first (`fetch` opens it as it is now, so it survives lifelog regrouping the conversation) and `turns` how
 * many. Null too when no turn overlaps.
 *
 * The words are in when, by lifelog's own signals (no timer of Life's): a turn of the same phone source starts at or
 * after `to`; or the last turn inside belongs to a recording that ended on silence and ended within
 * `RECORDING_ENDS_ON_SILENCE_AFTER` of `to`; or its conversation is closed and its end plus
 * `CONVERSATION_ENDS_AFTER` reaches `to`. In every case no recording of that source may be still to come between the
 * call's and the one the words are read through (`isPendingBefore`).
 * ponytail: only the last turn's phone source is judged when two record one call (rare). A `failed` recording is
 * terminal in lifelog, so its hole never fills: the words are then in with what there is. A hole between the source's
 * last turn before the call and the call's end that never fills (a recording stuck queued, a withdrawn page never sent
 * again) holds that call back until its 12 hours of looking end (`CALLS_BACK`), never a later call.
 */
export function recordingsOf(store: Store, from: string, to: string) {
  const { db } = store;
  const inside = db
    .query<InsideRow, [string, string]>(
      `select t.job_id, t.turn_index, t.start_at, t.conversation_id as conversation, c.end_at as conversation_end,
        c.closed, j.source_id, j.first_page,
        (select max(coalesce(o.end_at, o.start_at)) from turns o where o.job_id = t.job_id) as recording_end
      from turns t join conversations c on c.id = t.conversation_id
      left join transcription_jobs j on j.id = t.job_id
      where ${LIVE} and ${OVERLAPS} order by t.start_at, t.job_id, t.turn_index`
    )
    .all(from, to);
  const last = inside.at(-1);
  if (!last) {
    return null;
  }
  const after = db
    .query<{ first_page: number | null }, [string | null, string]>(
      `select j.first_page from turns t join conversations c on c.id = t.conversation_id
        left join transcription_jobs j on j.id = t.job_id
        where ${LIVE} and j.source_id is ?1 and t.start_at >= ?2 order by t.start_at limit 1`
    )
    .get(last.source_id, to);
  const [ended, closedBy] = [
    Date.parse(last.recording_end) + RECORDING_ENDS_ON_SILENCE_AFTER,
    Date.parse(last.conversation_end) + CONVERSATION_ENDS_AFTER,
  ];
  const stop = Date.parse(to);
  const settled =
    (endedOnSilence(store, last.job_id) && ended >= stop) ||
    (last.closed === 1 && closedBy >= stop);
  // The recording whose pages the words are read through: the later one, else the last inside.
  const through = after ?? (settled ? last : null);
  if (
    !through ||
    isPendingBefore(store, last.source_id, from, through.first_page)
  ) {
    return null;
  }
  return [...Map.groupBy(inside, (r) => r.conversation).values()].flatMap(
    ([first, ...rest]) =>
      first
        ? [
            {
              turn: turnRef(first.job_id, first.turn_index, first.start_at),
              turns: rest.length + 1,
            },
          ]
        : []
  );
}

/**
 * Whether a recording of phone source `source` with pages before `page` is still to come, only after the recording of
 * the source's last turn before `from` (any, with no turn before): queued or submitted, or withdrawn and held by no
 * other recording yet (lifelog sends its pages again, often joined into a recording that starts at another page). A row stored before `last_page` holds only its first page.
 * Nothing is known of a recording with no pages (`page` null).
 */
function isPendingBefore(
  { db }: Store,
  source: string | null,
  from: string,
  page: number | null
) {
  const before = db
    .query<{ first_page: number }, [string | null, string]>(
      `select j.first_page from turns t join transcription_jobs j on j.id = t.job_id
        where j.source_id is ?1 and j.first_page is not null and t.start_at < ?2 order by t.start_at desc limit 1`
    )
    .get(source, from)?.first_page;
  return Boolean(
    db
      .query<{ n: number }, [string | null, number | null, number]>(
        `select 1 as n from transcription_jobs w where w.source_id is ?1 and w.first_page > ?3 and w.first_page < ?2
          and (w.state in ('queued', 'submitted') or (w.state = 'withdrawn' and not exists (select 1 from transcription_jobs a
            where a.source_id is ?1 and a.state is not 'withdrawn' and a.first_page <= w.first_page
            and coalesce(a.last_page, a.first_page) >= w.first_page))) limit 1`
      )
      .get(source, page, before ?? -1)
  );
}
