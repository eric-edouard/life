import { matterFinderOf } from "../memory/matter-read";
import { dayStart, wall } from "../memory/zones";

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

/** The instant his local day `now` is in starts (`tz`: where he is now). */
export const handOutDayStartOf = (now: Date, tz?: string) =>
  dayStart(wall(now.toISOString(), tz).day, tz);

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
 * The matter to start an agent on: the first of `matters` (his ranking, next step to do) that no agent holds (`held`:
 * `heldByAgents`' steps), he did not dismiss (`dismissed`: the steps each dismissed matter was pinned to) and no open
 * "Start an agent on this?" check owns (`offered`: the matters' ids); none when no matter qualifies.
 */
export function handOutOf<
  M extends { id: string; steps: readonly string[] },
>(i: {
  dismissed: readonly (readonly string[])[];
  held: ReadonlySet<string>;
  matters: readonly M[];
  offered: ReadonlySet<string>;
}) {
  const find = matterFinderOf(
    i.matters.map((m) => ({ id: m.id, steps: m.steps.map((ref) => ({ ref })) }))
  );
  const dismissed = new Set(i.dismissed.map((pins) => find(pins)?.id));
  return i.matters.find(
    (m) =>
      !(
        dismissed.has(m.id) ||
        i.offered.has(m.id) ||
        m.steps.some((s) => i.held.has(s))
      )
  );
}
