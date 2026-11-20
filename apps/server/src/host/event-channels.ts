import { daysBefore, HOUR, iso, MIN } from "../core/clock";
import { paymentDayOf, paymentWordsOf } from "../memory/payments";
import { localDate } from "../memory/zones";
import { payments } from "../payments/backend";
import type { Payment, PaymentsBackend } from "../payments/contract";
import { type Stay, visits } from "../sources/lifelog";

// Event channels: what a wait's `channels` may name besides a message app, each read by the desk only for the waits
// that name it (`pollChannels`), and what a filter matches: one shape for every event (`Matchable`), so one matcher
// (`matcherOf`, `events.ts`) decides.

/**
 * An event as a filter sees it: a message, a call or a channel's event, each adapted where it is read. Its rules,
 * written once (`matcherOf`): no `fromMe` counts as not his, so `from_me: false` passes it and `from_me: true` does
 * not; a `chat`, `people`, `text`, quantity or `point` an event cannot answer matches nothing (a call has no text, a
 * payment no chat, people or point). An event channel's event is matched only by a filter whose `channels` names it. The text is only
 * tested: an event never carries it.
 */
export interface Matchable {
  channel: string;
  chat?: string;
  fromMe?: boolean;
  /** An event channel's: matched only by a filter whose `channels` names it. */
  isNamedOnly?: boolean;
  people?: string[];
  /** Where it happened: a filter's coordinates match it within their radius. */
  point?: { latitude: number; longitude: number };
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
  /** Whether its events hold a point (`Matchable.point`): only then may a filter on it take coordinates. */
  hasPoint: boolean;
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
  hasPoint: false,
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

/** How far back a read of stays looks. */
const PLACES_BACK = 48 * HOUR;

/**
 * A stay as an arrival: when, and where (its point as lifelog gives it), never the place's name (Apple's short name of a
 * fix: a third party's words, and it can be a neighbour's); the name is only tested, in Life's own line.
 */
function arrivalOf(s: Stay): ChannelEvent {
  const at = iso(Date.parse(s.arrivedAt));
  const id = `places:${s.arrivedAt}/arrived`;
  const point = { latitude: s.latitude, longitude: s.longitude };
  return {
    at,
    day: localDate(at),
    eventId: id,
    matchable: {
      channel: "places",
      isNamedOnly: true,
      point,
      text: s.place ? `arrived ${s.place}` : "arrived",
    },
    payload: {
      arrivedAt: s.arrivedAt,
      at,
      id,
      source: "places",
      what: "arrived",
      ...point,
    },
  };
}

/**
 * The places channel over lifelog's stays (`read`): each stay that began within the last `PLACES_BACK` is one arrival. A
 * stay that began before it is none: lifelog reads points from its own window, so such a stay's `arrivedAt` is cut at
 * the read's edge and moves at every poll.
 * ponytail: extra wakes for one real arrival are normal: lifelog lists a stay once an iOS visit arrives or two fixes in a
 * row lie there (5 to 10 minutes after he arrives while the pendant is connected, else when iOS delivers its visit); an
 * iOS visit that comes in after the fixes moves `arrivedAt` earlier, and a drift fix more than 150 m away splits one stay
 * in two: each gives one more arrival (an extra wake, never a miss; an agent is woken by events at most once per 10
 * minutes after its last turn). The upgrade: an id lifelog gives a stay.
 */
export const placesChannelOf = (
  read: (q: { from: string; to: string }) => Promise<Stay[]> = visits
): EventChannel => ({
  about:
    "each arrival at a place (`stay.arrived`), a few minutes after he gets there: name the place by `latitude`, `longitude` and `radius_m` (100 by default) as `read_places_visited` gives them, or by `text_matches` on `arrived <place>`; read it with `read_places_visited` at its `at`. Departures are not events yet",
  // Every poll (the desk's 30 seconds), only while a wait names it.
  beat: 0,
  // lifelog is Life's own service on the Mac: a failing read is the poll's "could not be read" line.
  block: () => null,
  event: "stay.arrived",
  hasPoint: true,
  name: "places",
  quantities: [],
  read: async (now) => {
    const from = now - PLACES_BACK;
    const stays = await read({ from: iso(from), to: iso(now) });
    return stays.filter((s) => Date.parse(s.arrivedAt) >= from).map(arrivalOf);
  },
});

export const EVENT_CHANNELS = [paymentsChannelOf(payments), placesChannelOf()];
