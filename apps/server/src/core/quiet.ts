import { MIN } from "./clock";

/** Speech is one conversation until nobody speaks for this long: the voice server's grouping and Life's spoken conversations cut at it. */
export const CONVERSATION_ENDS_AFTER = 5 * MIN;

/**
 * A recording ends on silence when nobody spoke for this long after its audio (the voice server's `endedOnSilence`, the cutter's
 * rule 3): the voice server's cutter closes its block at it, and Life reads a recording past it as complete.
 */
export const RECORDING_ENDS_ON_SILENCE_AFTER = MIN / 2;
