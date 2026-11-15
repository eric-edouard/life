import { HOUR } from "../core/clock";
import { packed } from "../core/lists";
import type { SourceEvent } from "../records/source";

/** With no message for this long an exchange is over: the next message opens a new one. */
export const EXCHANGE_ENDS_AFTER = 6 * HOUR;

/**
 * The characters of exchanges one call reads at most, when a stream's exchanges are read together: about 10,000
 * tokens, small on purpose. A read that marks what was said and done line by line gets worse as its input grows, so
 * this is far under what a call could take (`callCharsOf`), and it is a number of the read, not of an engine.
 */
export const EXCHANGE_BATCH_CHARS = 30_000;

/** The characters of messages' texts. */
export const charsOf = (list: SourceEvent[]) =>
  list.reduce((n, e) => n + e.text.length, 0);

/** What `exchangesOf` cuts: an instant and, for something that lasts, where it ends. */
interface Timed {
  at: string;
  end?: string | null;
}
const endOf = (x: Timed) => Date.parse(x.end ?? x.at);

/**
 * A stream of messages cut into exchanges, in time order: each a sitting of talk, a new one once nothing was written
 * for `quiet`. The caller chooses the stream: one person's messages across channels, or one chat. A spoken
 * conversation is cut the same way at `CONVERSATION_ENDS_AFTER`.
 */
export function exchangesOf<T extends Timed>(
  list: T[],
  quiet = EXCHANGE_ENDS_AFTER
) {
  const exchanges: T[][] = [];
  let latest = Number.NEGATIVE_INFINITY;
  for (const e of list.toSorted((a, b) => a.at.localeCompare(b.at))) {
    if (exchanges.length > 0 && Date.parse(e.at) - latest < quiet) {
      exchanges.at(-1)?.push(e);
    } else {
      exchanges.push([e]);
    }
    latest = Math.max(latest, endOf(e));
  }
  return exchanges;
}

/** An exchange nothing was written in for `quiet` as of `now`: the next message would open a new one, so it can no longer grow. */
export const isFinished = (
  exchange: Timed[],
  now: Date,
  quiet = EXCHANGE_ENDS_AFTER
) => now.getTime() - Math.max(...exchange.map(endOf)) >= quiet;

/** A two-way chat: both sides wrote in it, so there is an exchange to read. One only he or only they wrote in is not. */
export const isTwoWay = (chat: SourceEvent[]) =>
  chat.some((e) => e.fromMe) && chat.some((e) => !e.fromMe);

/**
 * Exchanges in batches, each what one call reads: consecutive exchanges up to `EXCHANGE_BATCH_CHARS`. An exchange is
 * never cut, so one over the size is a batch alone.
 */
export const batchesOf = (exchanges: SourceEvent[][]) =>
  packed(exchanges, EXCHANGE_BATCH_CHARS, charsOf);
