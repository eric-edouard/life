import { HOUR } from "../core/clock";
import type { SourceEvent } from "../records/source";

/** With no message for this long an exchange is over: the next message opens a new one. */
export const EXCHANGE_ENDS_AFTER = 6 * HOUR;

/**
 * A stream of messages cut into exchanges, in time order: each a sitting of talk, a new one once nothing was written
 * for `EXCHANGE_ENDS_AFTER`. The caller chooses the stream: one person's messages across channels, or one chat.
 */
export function exchangesOf(list: SourceEvent[]) {
  const exchanges: SourceEvent[][] = [];
  let last: SourceEvent | undefined;
  for (const e of list.toSorted((a, b) => a.at.localeCompare(b.at))) {
    if (last && Date.parse(e.at) - Date.parse(last.at) < EXCHANGE_ENDS_AFTER) {
      exchanges.at(-1)?.push(e);
    } else {
      exchanges.push([e]);
    }
    last = e;
  }
  return exchanges;
}
