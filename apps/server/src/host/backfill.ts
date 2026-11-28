import { clock, iso } from "../core/clock";
import type { Engine } from "../core/names";
import { listUsdOf, OPENROUTER_DEEPSEEK } from "../core/prices";
import type { Held } from "../sources/contract";

// The backfill's estimate: what reading his history from a day would cost, before he picks that day (the setup's
// range). Pure: what each source holds comes in as its `held` (`sources/contract.ts`), the price from `core/prices.ts`.

/**
 * What one message costs to read through every step (its context included): the measured ~$1 per dense month of chats
 * (about 10,000 messages) on OpenRouter. An item of a noun the table doesn't know is estimated as one message.
 */
const MESSAGE_TOKENS = 600;

/**
 * Input tokens one item costs to read through the memory steps, by what the item is (`Held.noun`).
 * ponytail: measured constants, recalibrate from real imports
 */
export const TOKENS_PER_ITEM: Record<string, number> = {
  calls: 200,
  commits: 400,
  conversations: 9000,
  events: 50,
  messages: MESSAGE_TOKENS,
  notes: 3000,
  photos: 500,
  readings: 50,
  tasks: 2000,
};
/** Input tokens the memory steps read in an hour, for the estimate's duration. ponytail: a guess, measure it on a pilot. */
export const TOKENS_PER_HOUR = 2_000_000;

/** A source's name and what its `held` says it holds now. */
export interface HeldSource {
  held: Held | null;
  name: string;
}

export interface BackfillEstimate {
  /** How long reading the range takes. */
  hours: number;
  /** Input tokens the steps read over it. */
  tokens: number;
  /** What a billed engine's credits would pay, on today's price; absent on a subscription. */
  usd?: number;
}

/** The UTC day of an instant: its items are counted by days, so a time of day never skews a share. */
const dayOf = (instant: string) => instant.slice(0, 10);

/**
 * What reading every source from the day `from` on would cost: each source's items in that range, counted by days from
 * the later of `from` and its earliest over its whole span, at `TOKENS_PER_ITEM`; priced only for a billed engine
 * (`openrouter`: `claude` and `codex` run on his subscriptions, so they have no dollars).
 */
export function backfillEstimateOf(
  sources: readonly HeldSource[],
  from: string,
  engine: Engine,
  today = dayOf(iso(clock().getTime()))
): BackfillEstimate {
  const start = Date.parse(from);
  const end = Date.parse(today);
  let tokens = 0;
  for (const { held } of sources) {
    if (!held?.earliest) {
      continue;
    }
    const earliest = Date.parse(dayOf(held.earliest));
    // The range's part of the source: none before its first item, all of it once the range starts before it.
    const inRange = end - Math.max(start, earliest);
    const span = end - earliest;
    if (inRange <= 0 || span <= 0) {
      continue;
    }
    tokens +=
      (held.count * inRange * (TOKENS_PER_ITEM[held.noun] ?? MESSAGE_TOKENS)) /
      span;
  }
  tokens = Math.round(tokens);
  // ponytail: a backfill's tokens are mostly what its steps read (input): the output share is not priced separately.
  const usd =
    engine === "openrouter"
      ? listUsdOf(OPENROUTER_DEEPSEEK, today, {
          cached: 0,
          input: tokens,
          output: 0,
        })
      : undefined;
  return {
    hours: tokens / TOKENS_PER_HOUR,
    tokens,
    ...(usd === undefined ? {} : { usd }),
  };
}
