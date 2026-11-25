import type { Database } from "bun:sqlite";
import type { TurnSpent } from "../memory/spends";

// The desk store's turns as spending reads them (`host/spending.ts`, the nightly's token rows), and how long handed work
// takes (`estimateOf`): beside `desk-read.ts`, read-only. A turn's matter is its assignment's (its anchors).

/**
 * The turns with their session's runtime for a turn before `turn.model` (a model names its own, read by `spendsOfTurn`),
 * found in one pass over the sessions (`session.ref` has no index).
 */
const SPENT =
  "agent_id, assignment_id, cost_usd, ended_at, model, search_usd, tokens_cached, tokens_in, tokens_out, legacy.runtime as runtime from turn left join (select ref, min(runtime) as runtime from session group by ref) legacy on turn.model is null and legacy.ref = turn.session";

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

/** The kinds of work the main session hands to an agent (`tell_agent`). */
export const HANDED_KINDS = [
  "booking",
  "lookup",
  "other",
  "redraft",
  "reply",
  "research",
] as const;
export type HandedKind = (typeof HANDED_KINDS)[number];

/** Each kind's first guess of how long it takes, until it has run five times. */
const HANDED_GUESS_MS: Record<HandedKind, number> = {
  booking: 600_000,
  lookup: 60_000,
  other: 180_000,
  redraft: 30_000,
  reply: 60_000,
  research: 300_000,
};

/** How many of a kind's last hand-overs `estimateOf` reads, and how many it needs before it trusts them over its guess. */
const ESTIMATE_OF_LAST = 20;
const ESTIMATE_FROM = 5;

/**
 * How long handed work of `kind` takes now, in ms: the median of its last 20 hand-overs, each from the hand-over to the
 * end of the first turn of its assignment that began after it (the agent's next card or `finish`); its fixed guess
 * until five have ended.
 */
export function estimateOf(db: Database, kind: HandedKind) {
  const took = db
    .query<{ ms: number }, [string, number]>(
      `select (julianday((select min(t.ended_at) from turn t where t.assignment_id = h.assignment_id and t.started_at >= h.handed_at and t.ended_at is not null)) - julianday(h.handed_at)) * 86400000 as ms
        from handed_work h where h.kind = ? order by h.handed_at desc limit ?`
    )
    .all(kind, ESTIMATE_OF_LAST)
    .flatMap((r) => (r.ms === null ? [] : [r.ms]))
    .sort((a, b) => a - b);
  return took.length < ESTIMATE_FROM
    ? HANDED_GUESS_MS[kind]
    : (took[Math.floor(took.length / 2)] as number);
}
