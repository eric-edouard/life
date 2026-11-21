import type { Database } from "bun:sqlite";
import type { TurnSpent } from "../memory/spends";

// The desk store's turns as spending reads them (`host/spending.ts`, the nightly's token rows): beside `desk-read.ts`,
// read-only, through `readDesk`. A turn's matter is its assignment's (its anchors), the one rule for both.

/**
 * The turns with their session's runtime for a turn before `turn.model` (a model names its own, read by `spendOfTurn`),
 * found in one pass over the sessions (`session.ref` has no index).
 */
const SPENT =
  "agent_id, assignment_id, ended_at, model, tokens_cached, tokens_in, tokens_out, legacy.runtime as runtime from turn left join (select ref, min(runtime) as runtime from session group by ref) legacy on turn.model is null and legacy.ref = turn.session";

/** A move's notes turn that never began ran no model (no session to resume, or a send that failed): never counted as spent. */
const RAN = "not (turn.cause = 'move_notes' and turn.begun_at is null)";

/** One ended turn's tokens, written when it ended (`close()`). */
export interface TurnTokens {
  agent_id: string;
  assignment_id: string;
  ended_at: string;
  tokens_cached: number;
  tokens_in: number;
  tokens_out: number;
}

/** The turns that ended since `since` (the last report), by `turn_by_ended`: a turn running across a report shows in the next. */
export const tokensSince = (db: Database, since: string) =>
  db
    .query<TurnTokens, [string]>(
      "select agent_id, assignment_id, ended_at, coalesce(tokens_in, 0) as tokens_in, coalesce(tokens_cached, 0) as tokens_cached, coalesce(tokens_out, 0) as tokens_out from turn where ended_at > ? order by ended_at"
    )
    .all(since);

/** The turns that ended from `from` to `to` (instants, `to` excluded), by `turn_by_ended`, as spends read them. */
export const turnsEndedIn = (db: Database, from: string, to: string) =>
  db
    .query<TurnSpent, [string, string]>(
      `select ${SPENT} where ended_at >= ? and ended_at < ? and ${RAN} order by ended_at`
    )
    .all(from, to);

/** The ended turns of each agent's current session, with the session's start: what its read shows it has spent. */
export function sessionTurnsOf(db: Database, agentIds: string[]) {
  if (agentIds.length === 0) {
    return { sessions: [], turns: [] };
  }
  const marks = agentIds.map(() => "?").join(",");
  const sessions = db
    .query<{ agent_id: string; started_at: string }, string[]>(
      `select a.id as agent_id, s.started_at from agent a join session s on s.ref = a.session where a.id in (${marks})`
    )
    .all(...agentIds);
  const turns = db
    .query<TurnSpent, string[]>(
      `select ${SPENT} where ended_at is not null and ${RAN} and agent_id in (${marks}) and session = (select session from agent where id = turn.agent_id)`
    )
    .all(...agentIds);
  return { sessions, turns };
}

/** The ended turns of every assignment anchored on any of `steps` (a matter's). */
export const stepTurnsOf = (db: Database, steps: string[]) =>
  steps.length === 0
    ? []
    : db
        .query<TurnSpent, string[]>(
          `select ${SPENT} where ended_at is not null and ${RAN} and assignment_id in (select assignment_id from anchor where step in (${steps.map(() => "?").join(",")}))`
        )
        .all(...steps);
