import {
  CONVERSATION_ENDS_AFTER,
  RECORDING_ENDS_ON_SILENCE_AFTER,
} from "../core/quiet";
import { LIVE, type Store, turnRef } from "./lifelog";

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
 * entry per conversation holding turns inside, `turn` the ref of its first turn inside (`fetch` opens it as it is now,
 * so it survives lifelog regrouping the conversation) and `turns` how many are inside. Null too when no turn is inside.
 *
 * The words are in when, by lifelog's own signals (no timer of Life's): a turn of the same phone source starts at or
 * after `to`; or the last turn inside belongs to a recording that ended on silence and ended within
 * `RECORDING_ENDS_ON_SILENCE_AFTER` of `to`; or its conversation is closed and its end plus
 * `CONVERSATION_ENDS_AFTER` reaches `to`. In every case no recording of that source with earlier pages may be queued or
 * submitted, and a withdrawn recording stays pending until the phone's pages come back as another.
 * ponytail: a `failed` recording is terminal in lifelog, so its hole never fills: the words are then in with what there
 * is. A recording stuck queued holds back every later call of its source; its 12 hours of looking end it.
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
      where ${LIVE} and t.start_at >= ?1 and t.start_at < ?2 order by t.start_at, t.job_id, t.turn_index`
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
  if (!through || isPendingBefore(store, last.source_id, through.first_page)) {
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
 * Whether a recording of phone source `source` with pages before `page` is still to come: queued or submitted, or
 * withdrawn and not yet sent again (another recording starting at its first page). Nothing is known of a recording with
 * no pages (`page` null).
 */
function isPendingBefore(
  store: Store,
  source: string | null,
  page: number | null
) {
  return Boolean(
    store.db
      .query<{ n: number }, [string | null, number | null]>(
        `select 1 as n from transcription_jobs w where w.source_id is ?1 and w.first_page < ?2 and (w.state in ('queued', 'submitted')
          or (w.state = 'withdrawn' and not exists (select 1 from transcription_jobs a where a.source_id is ?1
            and a.first_page = w.first_page and a.state <> 'withdrawn'))) limit 1`
      )
      .get(source, page)
  );
}
