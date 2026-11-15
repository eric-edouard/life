import { MIN } from "./clock";

/** Speech is one conversation until nobody speaks for this long: lifelog's grouping and Life's spoken conversations cut at it. */
export const CONVERSATION_ENDS_AFTER = 5 * MIN;
