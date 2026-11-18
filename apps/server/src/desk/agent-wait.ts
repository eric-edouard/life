import { z } from "zod";
import { DAY, iso, MIN } from "../core/clock";
import {
  type AgentRow,
  type EventRow,
  filtersOf,
  type TurnRow,
} from "../host/desk-read";
import { DECISION_ANSWERED, DECISION_LAPSED } from "../host/events";
import { AgentWait } from "../records/registered-agent";

// The wait contract's rules (docs: the desk spec, section 6), pure: rows and the time in, a decision out. The clock
// (`desk-clock.ts`) and the agent's actions (`agent-actions.ts`) apply them.

/** An agent wait ends 5 minutes to 7 days ahead. */
const WAIT_FROM = 5 * MIN;
const WAIT_TO = 7 * DAY;
/** The default wait, when a turn ends with neither `set_wait` nor `finish`. */
const DEFAULT_WAIT = DAY;
/** An event other than his answer wakes an agent once this has passed since its last turn. */
const EVENT_GAP = 10 * MIN;
/** A failed turn is tried again after each of these, then the default wait stands. */
const RETRIES = [5 * MIN, 10 * MIN, 20 * MIN];
/** An event is handed to this many turns that did not consume it (once, then again 3 times at most), then dropped. */
export const MAX_HANDED = RETRIES.length + 1;
/**
 * A wake sends into the session while it has grown less than this since its first turn; past it, a fresh session
 * starts from the packet. Growth, not size: a new session already holds 28,000 to 78,000 tokens (the runtime proofs).
 */
export const GROWTH_LIMIT = 30_000;
/** At most this many turns start in one tick, his answers first, then the oldest deadline. */
export const STARTS_PER_TICK = 3;
/** His answer to an agent's decision, or its lapse: either wakes the agent at once. */
export const ANSWERS = [DECISION_ANSWERED, DECISION_LAPSED];

const at = (t: string) => new Date(t).getTime();

/** A wait an agent asks for, or why it is refused (its shape, or `until` outside 5 minutes to 7 days from `now`). */
export function waitOf(input: unknown, now: number) {
  const parsed = AgentWait.safeParse(input);
  if (!parsed.success) {
    return { error: z.prettifyError(parsed.error) };
  }
  const ahead = at(parsed.data.until) - now;
  return ahead < WAIT_FROM || ahead > WAIT_TO
    ? { error: "until must be 5 minutes to 7 days ahead" }
    : { wait: parsed.data };
}

/** The default wait: the old filters, 24 hours, flagged. */
export const defaultWaitOf = (a: AgentRow, now: number): AgentWait => ({
  events: filtersOf(a),
  reason: "default wait: the last turn ended with neither set_wait nor finish",
  until: iso(now + DEFAULT_WAIT),
});

/** How many desk turns failed in a row, last first: a failed turn and the retries after it (a new cause starts a new run). */
export const failuresOf = (turns: TurnRow[]) => {
  let n = 0;
  for (const t of turns) {
    if (t.outcome !== "failed") {
      break;
    }
    n += 1;
    if (t.cause !== "retry") {
      break;
    }
  }
  return n;
};

/**
 * When an agent's next turn is due and why, or null while a desk turn runs: a failed turn's retry; else the soonest of
 * his answer (at once), another event (10 minutes after its last turn) and its deadline.
 */
export function dueOf(a: AgentRow, turns: TurnRow[], events: EventRow[]) {
  const [last] = turns;
  if (last && !last.ended_at) {
    return null;
  }
  const failures = failuresOf(turns);
  if (last?.ended_at && failures > 0 && failures <= RETRIES.length) {
    return {
      at: at(last.ended_at) + (RETRIES[failures - 1] ?? 0),
      cause: "retry",
    };
  }
  const answer = events.find((e) => ANSWERS.includes(e.name));
  if (answer) {
    return { at: at(answer.received_at), cause: "answer" };
  }
  const deadline = { at: at(a.wait_until ?? a.created_at), cause: "deadline" };
  const [first] = events;
  if (!first) {
    return deadline;
  }
  const event = {
    at: Math.max(
      at(first.received_at),
      last?.ended_at ? at(last.ended_at) + EVENT_GAP : 0
    ),
    cause: "event",
  };
  return event.at < deadline.at ? event : deadline;
}
