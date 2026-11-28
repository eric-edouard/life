import { clock, MIN } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { accessStepsOf, isAccessDone } from "../memory/access";
import { type Decision, doneSeenByOf } from "../memory/decision-lines";
import {
  decisionsNow,
  type LookForDone,
  recordDoneSeen,
} from "../memory/decisions";
import { accessOf, amountOf, isToPayee, payeeWordsOf } from "../memory/needs";
import { dayStart, localDate } from "../memory/zones";
import type { EventFilter } from "../records/registered-agent";
import {
  type ChannelEvent,
  EVENT_CHANNELS,
  type EventChannel,
  isOnOrAfter,
} from "./event-channels";
import { matcherOf } from "./events";
import { readAccessNow, showAccessStepOnMac } from "./mac-access";

// Life seeing a card's step done itself (`doneSeenBy`, the asks contract): the card's filter, built from its needs, is
// tested by the one matcher (`matcherOf`) over the payments channel's events, never a second matcher (amendment 1). Two
// callers: his pick of the card's `looks` option (`lookForDone`, given to `answerDecision`) and the watcher's look
// while a card is open (`lookForPaymentsDone`), which writes `seen` only: a statement imported days late still ends it.
// An access card is seen on the Mac instead (`lookAtMac`, `lookForAccessDone`): its steps all done.

/** An amount in a bank's currency is exact to the cent: half a cent either side. */
const HALF_CENT = 0.005;
/** How often the watcher looks while a payment card is open: the payments channel's own beat. */
const LOOK_EVERY = 5 * MIN;

const PAYMENTS = EVENT_CHANNELS.find(
  (c) => c.name === "payments"
) as EventChannel;

/** The filter that sees `d`'s payment by its amount: money out of exactly its `amount` need, in its own currency. */
function doneSeenFilterOf(d: Pick<Decision, "needs">): EventFilter | undefined {
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

/**
 * Whether `e` is `d`'s payment: its amount by the one matcher, paid in the card's own currency (`eur_out` also holds
 * every payment's EUR value), to its payee by the bank's name of it alone (`ChannelEvent.payee`, never his note).
 */
function paymentTestOf(d: Pick<Decision, "needs">) {
  const filter = doneSeenFilterOf(d);
  const isMatch = filter && matcherOf(filter);
  const currency = amountOf(d.needs)?.currency;
  const words = payeeWordsOf(d.needs);
  return (
    isMatch &&
    ((e: ChannelEvent) =>
      isMatch(e.matchable) &&
      e.payload.currency === currency &&
      isToPayee(e.payee ?? "", words))
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
      const isPayment = paymentTestOf(d);
      const since = dayStart(localDate(d.at)).toISOString();
      const seen =
        isPayment &&
        events.find(
          (e) =>
            !claimed.has(e.eventId) && isOnOrAfter(e, since) && isPayment(e)
        );
      if (seen) {
        claimed.add(seen.eventId);
      }
      return seen ? [[d.id, seen.eventId] as const] : [];
    })
  );
}

/** The id of an access card's `seen` line: the card's own, since no event of the Mac's names it. */
const accessSeenIdOf = (id: string) => `access:${id}`;

/**
 * His "I'm at my Mac" on access card `d`: every step done, the card is seen; else its first step not done is shown
 * on his Mac (`showAccessStepOnMac`) and nothing is seen: his answer is voided and the card stays open, ticking.
 */
export async function lookAtMac(
  d: Pick<Decision, "id" | "needs">,
  read = readAccessNow,
  show = showAccessStepOnMac
) {
  const need = accessOf(d.needs);
  if (!need) {
    return;
  }
  const next = accessStepsOf(need.steps, await read()).find(
    (s) => s.status !== "done"
  );
  if (!next) {
    return accessSeenIdOf(d.id);
  }
  await show(next.check, next.status);
}

/** His answer's look: on an access card, his Mac (`lookAtMac`); else the payment that shows `d`'s step done, or none. */
export const lookForDone: LookForDone = async (d) =>
  doneSeenByOf(d) === "access"
    ? lookAtMac(d)
    : (await readSeenDone([d])).get(d.id);

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
    log("run.error", { ...errorOf(e), step: "watch.done-seen" });
  } finally {
    looking = false;
  }
}

let accessLooking = false;

/**
 * The watcher's minute for access cards: while one is open, one read of the Mac (`readAccessNow`, which also keeps the
 * statuses the cards show), and a `seen` line for each card whose steps are all done. A step refused or ignored
 * writes nothing: the card stays asked, never chased.
 */
export async function lookForAccessDone(read = readAccessNow) {
  const open = decisionsNow().filter(
    (d) => d.state === "open" && doneSeenByOf(d) === "access"
  );
  if (accessLooking || open.length === 0) {
    return;
  }
  accessLooking = true;
  try {
    const statuses = await read();
    for (const d of open) {
      const need = accessOf(d.needs);
      if (need && isAccessDone(need.steps, statuses)) {
        recordDoneSeen(d.id, { eventId: accessSeenIdOf(d.id), state: "seen" });
      }
    }
  } finally {
    accessLooking = false;
  }
}
