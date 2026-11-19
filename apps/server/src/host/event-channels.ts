import { daysBefore, iso, MIN } from "../core/clock";
import { paymentDayOf, paymentWordsOf } from "../memory/payments";
import { localDate } from "../memory/zones";
import { payments } from "../payments/backend";
import type { Payment, PaymentsBackend } from "../payments/contract";

// Event channels: what a wait's `channels` may name besides a message app, each read by the desk only for the waits
// that name it (`pollChannels`), and what a filter matches: one shape for every event (`Matchable`), so one matcher
// (`matcherOf`, `events.ts`) decides.

/**
 * An event as a filter sees it: a message, a call or a channel's event, each adapted where it is read. Its rules,
 * written once (`matcherOf`): no `fromMe` counts as not his, so `from_me: false` passes it and `from_me: true` does
 * not; a `chat`, `people`, `text` or quantity an event cannot answer matches nothing (a call has no text, a payment no
 * chat or people). An event channel's event is matched only by a filter whose `channels` names it. The text is only
 * tested: an event never carries it.
 */
export interface Matchable {
  channel: string;
  chat?: string;
  fromMe?: boolean;
  /** An event channel's: matched only by a filter whose `channels` names it. */
  isNamedOnly?: boolean;
  people?: string[];
  quantities?: Record<string, number>;
  text?: string;
}

/** One event a channel read: its id, its instant when known, its local day, what a filter sees, and what a wake hands. */
export interface ChannelEvent {
  at?: string;
  day: string;
  eventId: string;
  matchable: Matchable;
  payload: Record<string, unknown>;
}

export interface EventChannel {
  /** What the door says of it, after its name and quantities. */
  about: string;
  /** How often it is read while a wait names it. */
  beat: number;
  /** Why it cannot be read now, or null. */
  block: () => string | null;
  /** The event it queues. */
  event: string;
  name: string;
  /** The quantities its events hold, by name. */
  quantities: string[];
  /** Its events over its look-back to `now`; throws when it cannot be read. */
  read: (now: number) => Promise<ChannelEvent[]>;
}

const PAYMENTS_OFF = "payments are off in his settings";
/** A read of the money app that takes longer fails, so the desk's tick goes on. */
const READ_WITHIN_MS = 20_000;
/** How many days back a read of payments looks: a statement imported late still wakes. */
const PAYMENTS_BACK_DAYS = 35;

/** A payment as an event: money out or in by the sign of `eur`, its words to match, its facts (never the merchant or note). */
function paymentEventOf(p: Payment): ChannelEvent {
  const at = p.paidAt ? iso(Date.parse(p.paidAt)) : undefined;
  const day = paymentDayOf(p);
  const id = `payments:${p.id}`;
  const quantities = { [p.eur < 0 ? "eur_out" : "eur_in"]: Math.abs(p.eur) };
  const { category, merchant, note } = paymentWordsOf(p);
  return {
    ...(at ? { at } : {}),
    day,
    eventId: id,
    matchable: {
      channel: "payments",
      isNamedOnly: true,
      quantities,
      text: [merchant, category, note].filter(Boolean).join("\n"),
    },
    payload: {
      amount: p.amount,
      at: at ?? null,
      category: p.category,
      currency: p.currency,
      day,
      id,
      source: "payments",
      spending: p.spending,
      ...quantities,
    },
  };
}

/** The payments channel over `backend` (none: payments are off): each payment booked in the last `PAYMENTS_BACK_DAYS`. */
export const paymentsChannelOf = (
  backend: () => PaymentsBackend | undefined
): EventChannel => ({
  about:
    "`text_matches` tests the merchant, the category and his note; read one with `read_payments` on its `day`",
  beat: 5 * MIN,
  block: () => (backend() ? null : PAYMENTS_OFF),
  event: "payment.booked",
  name: "payments",
  quantities: ["eur_out", "eur_in"],
  read: async (now) => {
    const b = backend();
    if (!b) {
      throw new Error(PAYMENTS_OFF);
    }
    const to = localDate(iso(now));
    const list = await b.between(daysBefore(to, PAYMENTS_BACK_DAYS), to, {
      timeoutMs: READ_WITHIN_MS,
    });
    return list.map(paymentEventOf);
  },
});

export const EVENT_CHANNELS = [paymentsChannelOf(payments)];
