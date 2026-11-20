import { clock, MIN } from "../core/clock";
import { log } from "../core/log";
import {
  type Decision,
  decisionsNow,
  doneSeenByOf,
  type LookForDone,
  recordDoneSeen,
} from "../memory/decisions";
import { amountOf } from "../memory/needs";
import { dayStart, localDate } from "../memory/zones";
import type { EventFilter } from "../records/registered-agent";
import {
  EVENT_CHANNELS,
  type EventChannel,
  isOnOrAfter,
} from "./event-channels";
import { matcherOf } from "./events";

// Life seeing a card's step done itself (`doneSeenBy`, the asks contract): the card's filter, built from its needs, is
// tested by the one matcher (`matcherOf`) over the payments channel's events, never a second matcher (amendment 1). Two
// callers: his pick of the card's `looks` option (`lookForDone`, given to `answerDecision`) and the watcher's look
// while a card is open (`lookForPaymentsDone`), which writes `seen` only: a statement imported days late still ends it.

/** An amount in a bank's currency is exact to the cent: half a cent either side. */
const HALF_CENT = 0.005;
/** How often the watcher looks while a payment card is open: the payments channel's own beat. */
const LOOK_EVERY = 5 * MIN;

const PAYMENTS = EVENT_CHANNELS.find(
  (c) => c.name === "payments"
) as EventChannel;

/** The filter that sees `d`'s payment: money out of exactly its `amount` need, in its own currency. */
export function doneSeenFilterOf(
  d: Pick<Decision, "needs">
): EventFilter | undefined {
  const amount = amountOf(d.needs);
  return (
    amount && {
      above: amount.value - HALF_CENT,
      below: amount.value + HALF_CENT,
      channels: [PAYMENTS.name],
      from_me: false,
      quantity: `${amount.currency.toLowerCase()}_out`,
    }
  );
}

/** Each card's step seen done, from one read of `channel`: its id to the event's, booked on or after the card's day. */
export async function readSeenDone(
  cards: Omit<Decision, "state">[],
  now = clock().getTime(),
  channel = PAYMENTS
) {
  const events = await channel.read(now);
  // One payment settles one card: seeded from the `seen` lines already stored, filled as cards match.
  const claimed = new Set(
    decisionsNow().flatMap((d) =>
      d.doneSeen?.eventId ? [d.doneSeen.eventId] : []
    )
  );
  return new Map(
    cards.flatMap((d) => {
      const filter = doneSeenFilterOf(d);
      const isMatch = filter && matcherOf(filter);
      const since = dayStart(localDate(d.at)).toISOString();
      const seen =
        isMatch &&
        events.find(
          (e) =>
            !claimed.has(e.eventId) &&
            isOnOrAfter(e, since) &&
            isMatch(e.matchable)
        );
      if (seen) {
        claimed.add(seen.eventId);
      }
      return seen ? [[d.id, seen.eventId] as const] : [];
    })
  );
}

/** His answer's look: the payment that shows `d`'s step done, or none. */
export const lookForDone: LookForDone = async (d) =>
  (await readSeenDone([d])).get(d.id);

let lookedAt = Number.NEGATIVE_INFINITY;
let looking = false;

/**
 * The watcher's minute: at most every `LOOK_EVERY`, one at a time, one read for every open payment card (none open:
 * nothing read), and a `seen` line for each card whose payment is in. Nothing found writes nothing: the card stays.
 */
export async function lookForPaymentsDone(now = clock().getTime()) {
  if (looking || now - lookedAt < LOOK_EVERY) {
    return;
  }
  const open = decisionsNow().filter(
    (d) => d.state === "open" && doneSeenByOf(d) === "payment"
  );
  if (open.length === 0) {
    return;
  }
  looking = true;
  lookedAt = now;
  try {
    for (const [id, eventId] of await readSeenDone(open, now)) {
      recordDoneSeen(id, { eventId, state: "seen" });
    }
  } catch (e) {
    log("run.error", { error: (e as Error).message, step: "watch.done-seen" });
  } finally {
    looking = false;
  }
}
