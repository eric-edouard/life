import { z } from "zod";
import { DAY, iso, MIN } from "../core/clock";
import {
  type AssignmentRow,
  type EventRow,
  filtersOf,
  type TurnRow,
} from "../host/desk-read";
import { DECISION_EVENTS } from "../host/events";
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
/** An event is handed to this many turns that began and did not consume it (once, then again 3 times at most), then dropped. */
export const MAX_HANDED = RETRIES.length + 1;
/**
 * A wake sends into the session while it has grown less than this since its first turn; past it, a fresh session
 * starts from the packet. Growth, not size: a new session already holds 28,000 to 78,000 tokens (the runtime proofs),
 * and one event turn's reads add 15,000 to 70,000 (measured 20 Nov 2026): at 30,000 every second wake went fresh.
 */
export const GROWTH_LIMIT = 120_000;
/**
 * How much a session has grown since its first call: the context of its newest call that a turn kept, less its first
 * call's (`session.context_at_first_call`). With either missing it is 0: the wake then sends into the session.
 */
export function growthOf(
  session: { context_at_first_call: number | null } | null,
  turns: Pick<TurnRow, "context_used">[]
) {
  const last = turns.find((t) => t.context_used !== null)?.context_used;
  const first = session?.context_at_first_call;
  return typeof last !== "number" || typeof first !== "number"
    ? 0
    : last - first;
}

/** At most this many turns start in one tick, his answers first, then the oldest deadline. */
export const STARTS_PER_TICK = 3;

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

/** A queued event as an agent reads it: its name and its facts. */
export const eventLineOf = (e: Pick<EventRow, "name" | "payload">) =>
  `${e.name} ${e.payload}`;

/** An assignment's default wait: its old filters, 24 hours, flagged. */
export const defaultWaitOf = (
  s: Pick<AssignmentRow, "wait_events">,
  now: number
): AgentWait => ({
  events: filtersOf(s),
  reason: "default wait: the last turn ended with neither set_wait nor finish",
  until: iso(now + DEFAULT_WAIT),
});

/** How many of an assignment's desk turns failed in a row, last first: a failed turn and the retries after it (a new cause starts a new run). */
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

/** How long a launched run may take to begin (its model's first answer) before the desk stops it: a hung door or CLI. */
export const BEGIN_WITHIN_MS = 5 * MIN;

/** Whether desk turn `t` has gone `BEGIN_WITHIN_MS` since it was launched without beginning (its model never answered). */
export const isBeginLate = (t: TurnRow, now: number) =>
  !(t.begun_at || t.ended_at) && now - at(t.started_at) > BEGIN_WITHIN_MS;

/**
 * When an assignment's next turn is due and why, from its own turns and events, or null while its turn runs: a failed
 * turn's retry; else the soonest of his answer (at once, or, its retries spent, the last retry's gap after the last
 * failure), another event (10 minutes after its last turn) and its deadline. Whether its agent's session runs another
 * turn is the clock's to check.
 */
export function nextWakeOf(
  s: Pick<AssignmentRow, "opened_at" | "wait_until">,
  turns: TurnRow[],
  events: EventRow[]
) {
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
  // His answer to its decision, its lapse or its withdrawal (he answered in the chat): each wakes the agent at once.
  const answer = events.find((e) => DECISION_EVENTS.includes(e.name));
  if (answer) {
    // Its retries spent (turns that never began drop nothing), his answer is tried again at the last retry's gap, never at once.
    const spent =
      last?.ended_at && failures > RETRIES.length
        ? at(last.ended_at) + (RETRIES.at(-1) ?? 0)
        : 0;
    return { at: Math.max(at(answer.received_at), spent), cause: "answer" };
  }
  const deadline = { at: at(s.wait_until ?? s.opened_at), cause: "deadline" };
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
