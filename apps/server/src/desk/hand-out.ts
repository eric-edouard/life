import { HOUR } from "../core/clock";
import type { AssignmentRow } from "../host/desk-read";
import {
  type HandOutFacts,
  type HandOutMatter,
  handOutGateOf,
} from "../memory/read-matters";

// The hand-out: what the desk gives an agent by itself (his word of 20 Nov 2026: agents start on their own on his
// matters; nothing leaves without his yes). Code picks the matter from his ranking and the agent that takes it
// (`agentForOf`); the agent reads the matter as data. Pure, as `agent-wait.ts` is: the tick (`hand-out-tick.ts`) reads
// and assigns.

/** `desk.handOut` in his settings: the pace. */
export interface Pace {
  aDay: number;
  cardsWaiting: number;
}

/** Why the pace allows no start now, or null: enough cards wait for him, or enough started today. */
export function paceRefusalOf(
  pace: Pace,
  { cardsOpen, startedToday }: { cardsOpen: number; startedToday: number }
) {
  if (cardsOpen >= pace.cardsWaiting) {
    return `${cardsOpen} agent cards wait for him`;
  }
  return startedToday >= pace.aDay
    ? `${startedToday} started on his day already`
    : null;
}

/**
 * The matter to start an agent on: the first of `matters` (his ranking) that passes every gate of `handOutGateOf`
 * (`facts`, with `isHeld`, the hold rule `isHeldOf`); none when no matter qualifies.
 */
export function handOutOf(i: {
  facts: HandOutFacts;
  matters: readonly HandOutMatter[];
}) {
  return i.matters.find((m) => handOutGateOf(m, i.facts) === null);
}

/** How long a handed-out agent has to ask a card or set a wait, from its first turn's beginning. */
export const CARD_WITHIN_MS = 2 * HOUR;

/** The outcome of an assignment closed for neither asking nor waiting in time. */
export const NO_CARD_OUTCOME = `no card and no wait within ${CARD_WITHIN_MS / HOUR} hours`;

/**
 * Whether an assignment the desk opened is over its time: open, its own first turn began (`first_begun_at`),
 * `CARD_WITHIN_MS` since, no card asked (`hasAsked`) and no wait of its agent's own ahead (one that works, then waits,
 * stays). One he opened never is.
 */
export const isCardOverdue = (
  a: Pick<
    AssignmentRow,
    "closed_at" | "opened_by" | "wait_is_default" | "wait_until"
  > & {
    first_begun_at: string | null;
  },
  hasAsked: boolean,
  now: number
) =>
  a.opened_by === "desk" &&
  a.closed_at === null &&
  a.first_begun_at !== null &&
  !hasAsked &&
  !(a.wait_is_default === 0 && Date.parse(a.wait_until ?? "") > now) &&
  now - Date.parse(a.first_begun_at) >= CARD_WITHIN_MS;
