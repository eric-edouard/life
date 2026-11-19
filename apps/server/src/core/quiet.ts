import { MIN } from "./clock";

/** Speech is one conversation until nobody speaks for this long: lifelog's grouping and Life's spoken conversations cut at it. */
export const CONVERSATION_ENDS_AFTER = 5 * MIN;

/**
 * A recording ends on silence when nobody spoke for this long after its audio (lifelog's `endedOnSilence`, the cutter's
 * rule 3): lifelog's cutter closes its block at it, and Life reads a recording past it as complete.
 */
export const RECORDING_ENDS_ON_SILENCE_AFTER = MIN / 2;
