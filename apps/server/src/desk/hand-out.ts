import { HOUR } from "../core/clock";
import type { AssignmentRow } from "../host/desk-read";
import {
  type HandOutFacts,
  type HandOutMatter,
  handOutGateOf,
} from "../memory/read-matters";

// The hand-out: what the desk starts an agent on by itself (his word of 20 Nov 2026: agents start on their own on his
// matters; nothing leaves without his yes). Code picks the matter from his ranking; the brief is this constant; the
// agent reads the matter as data. Pure, as `agent-wait.ts` is: the tick (`hand-out-tick.ts`) reads and starts.

/** The brief of a handed-out agent: the same for every matter, so no word of his is faked and none of Life's is a command. */
export const HAND_OUT_BRIEF =
  "Life started you on this matter from the top of his ranking; he gave no word about it. The contract says what your first turn does.";

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

/** How long a handed-out agent has to ask its card, from its first turn's beginning. */
export const CARD_WITHIN_MS = 2 * HOUR;

/** The outcome of an agent ended for asking no card in time. */
export const NO_CARD_OUTCOME = `no card within ${CARD_WITHIN_MS / HOUR} hours`;

/** Whether an assignment the desk opened is over its time to ask: open, its own first turn began (`first_begun_at`), no card asked (`hasAsked`) and `CARD_WITHIN_MS` since. One he opened never is. */
export const isCardOverdue = (
  a: Pick<AssignmentRow, "closed_at" | "opened_by"> & {
    first_begun_at: string | null;
  },
  hasAsked: boolean,
  now: number
) =>
  a.opened_by === "desk" &&
  a.closed_at === null &&
  a.first_begun_at !== null &&
  !hasAsked &&
  now - Date.parse(a.first_begun_at) >= CARD_WITHIN_MS;
