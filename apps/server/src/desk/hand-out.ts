import { HOUR } from "../core/clock";
import { type AgentRow, agentKindOf } from "../host/desk-read";
import { matterFinderOf } from "../memory/matter-read";

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
 * The matter to start an agent on: the first of `matters` (his ranking, next step to do) that no agent holds (`isHeld`:
 * the hold rule, `isHeldOf`) and he did not dismiss (`dismissed`: the steps each dismissed matter was pinned to); none
 * when no matter qualifies.
 */
export function handOutOf<
  M extends { id: string; steps: readonly { at: string; ref: string }[] },
>(i: {
  dismissed: readonly (readonly string[])[];
  isHeld: (m: M) => boolean;
  matters: readonly M[];
}) {
  const find = matterFinderOf(i.matters);
  const dismissed = new Set(i.dismissed.map((pins) => find(pins)?.id));
  return i.matters.find((m) => !(dismissed.has(m.id) || i.isHeld(m)));
}

/** How long a handed-out agent has to ask its card, from its first turn's beginning. */
export const CARD_WITHIN_MS = 2 * HOUR;

/** The outcome of an agent ended for asking no card in time. */
export const NO_CARD_OUTCOME = `no card within ${CARD_WITHIN_MS / HOUR} hours`;

/** Whether a handed-out agent is over its time to ask: active, its first turn began (`first_begun_at`), no card asked (`hasAsked`) and `CARD_WITHIN_MS` since. One he started himself never is. */
export const isCardOverdue = (
  a: Pick<AgentRow, "is_handed_out" | "status"> & {
    first_begun_at: string | null;
  },
  hasAsked: boolean,
  now: number
) =>
  agentKindOf(a) === "handed_out" &&
  a.status === "active" &&
  a.first_begun_at !== null &&
  !hasAsked &&
  now - Date.parse(a.first_begun_at) >= CARD_WITHIN_MS;
