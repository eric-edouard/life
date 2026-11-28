import { clock, daysBefore, HOUR, iso, MIN } from "../core/clock";
import { isOwnLife } from "../core/platform";
import { paymentDayOf, paymentWordsOf } from "../memory/payments";
import { localDate } from "../memory/zones";
import { payments } from "../payments/backend";
import type { Payment, PaymentsBackend } from "../payments/contract";
import type { EventFilter } from "../records/registered-agent";
import { type GithubActivity, githubActivityReader } from "../sources/github";
import { type Stay, visits } from "../sources/voice-server";

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
  /** A GitHub activity's repo, `owner/name`: such an event is matched only by a filter naming its `repo`. */
  repo?: string;
  text?: string;
}

/** Whether an event came at or after the instant `since`: by its own instant when known, else by its local day against `since`'s. */
export const isOnOrAfter = (e: { at?: string; day?: string }, since: string) =>
  e.at ? e.at >= since : (e.day ?? "") >= localDate(since);

/** One event a channel read: its id, its instant when known, its local day, what a filter sees, and what a wake hands. */
export interface ChannelEvent {
  at?: string;
  day: string;
  eventId: string;
  matchable: Matchable;
  /** A payment's payee as the bank names it, whole: read on the Mac to see a card paid (`host/done-seen.ts`), never handed to an agent. */
  payee?: string;
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
  /** Whether its events hold a repo (`Matchable.repo`): then a filter on it must name one, and the repos named are all it reads. */
  hasRepo: boolean;
  name: string;
  /** The quantities its events hold, by name. */
  quantities: string[];
  /** Its events over its look-back to `now`, given the open waits' filters that name it; throws when it cannot be read. */
  read: (now: number, filters?: EventFilter[]) => Promise<ChannelEvent[]>;
}

const PAYMENTS_OFF = "payments are off in his settings";
/** A read of the money app that takes longer fails, so the desk's tick goes on. */
const READ_WITHIN_MS = 20_000;
/** How many days back a read of payments looks: a statement imported late still wakes. */
const PAYMENTS_BACK_DAYS = 35;

/** A bank's own account-name field, which names the payee when the merchant is a shop's name ("SHOP (A/C Name: SHOP CO.,LTD.)"). */
const ACCOUNT_NAME = /\bA\/C Name:/i;

/**
 * Who a payment went to, as its bank line names it: its account-name field when the bank gives one, its own brackets
 * kept ("North (UK) Services Ltd"), to the bracket that closes the one it sits in; else the whole line. A field given
 * blank, or one whose bracket never closes, names no one: its end is not known.
 */
const payeeOf = (merchant: string) => {
  const field = ACCOUNT_NAME.exec(merchant);
  if (!field) {
    return merchant;
  }
  let open = 0;
  for (const ch of merchant.slice(0, field.index)) {
    open = Math.max(0, open + (ch === "(" ? 1 : 0) - (ch === ")" ? 1 : 0));
  }
  let depth = 0;
  let name = "";
  for (const ch of merchant.slice(field.index + field[0].length)) {
    depth += ch === "(" ? 1 : 0;
    depth -= ch === ")" ? 1 : 0;
    if (depth < 0) {
      return name.trim();
    }
    name += ch;
  }
  return open > 0 ? "" : name.trim();
};

/**
 * A payment as an event: money out or in by its sign, as `<currency>_out` or `_in` in its own currency (`thb_out`, what a
 * card's look matches, `host/done-seen.ts`) and in EUR (`eur_out`, what a wait may name), its words to match, its facts
 * (never the merchant or note).
 */
function paymentEventOf(p: Payment): ChannelEvent {
  const at = p.paidAt ? iso(Date.parse(p.paidAt)) : undefined;
  const day = paymentDayOf(p);
  const id = `payments:${p.id}`;
  const way = p.amount < 0 ? "out" : "in";
  const quantities = {
    [`${p.currency.toLowerCase()}_${way}`]: Math.abs(p.amount),
    [`eur_${way}`]: Math.abs(p.eur),
  };
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
    payee: payeeOf(p.merchant),
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
  hasRepo: false,
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
/** A read of stays that takes longer fails, so a hanging the voice server never holds the desk's tick (read at every poll). */
const PLACES_READ_WITHIN_S = 10;

/**
 * A stay as an arrival: when, and where (its point as the voice server gives it), never the place's name (Apple's short name of a
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
 * The places channel over the voice server's stays (`read`): each stay that began within the last `PLACES_BACK` is one arrival. A
 * stay that began before it is none: The voice server reads points from its own window, so such a stay's `arrivedAt` is cut at
 * the read's edge and moves at every poll.
 * ponytail: extra wakes for one real arrival are normal: The voice server lists a stay once an iOS visit arrives or two fixes in a
 * row lie there (5 to 10 minutes after he arrives while the pendant is connected, else when iOS delivers its visit); an
 * iOS visit that comes in after the fixes moves `arrivedAt` earlier, and a drift fix more than 150 m away splits one stay
 * in two: each gives one more arrival (an extra wake, never a miss; an agent is woken by events at most once per 10
 * minutes after its last turn). The upgrade: an id the voice server gives a stay.
 */
export const placesChannelOf = (
  read: (
    q: { from: string; to: string },
    timeoutS: number
  ) => Promise<Stay[]> = visits
): EventChannel => ({
  about:
    "each arrival at a place (`stay.arrived`), a few minutes after he gets there: name the place by `latitude`, `longitude` and `radius_m` (100 by default) as `read_places_visited` gives them, or by `text_matches` on `arrived <place>`; read it with `read_places_visited` at its `at`. Departures are not events yet",
  // Every poll (the desk's 30 seconds), only while a wait names it.
  beat: 0,
  // The voice server is Life's own service on the Mac: a failing read is the poll's "could not be read" line.
  block: () => null,
  event: "stay.arrived",
  hasPoint: true,
  hasRepo: false,
  name: "places",
  quantities: [],
  read: async (now) => {
    const from = now - PLACES_BACK;
    const stays = await read(
      { from: iso(from), to: iso(now) },
      PLACES_READ_WITHIN_S
    );
    return stays.filter((s) => Date.parse(s.arrivedAt) >= from).map(arrivalOf);
  },
});

/**
 * A GitHub activity as an event: its facts (repo, number, who, kind with what was done, link, when); its title and body are
 * only tested (`text_matches`), never handed or kept. The queued wake holds the facts only.
 */
function githubEventOf(a: GithubActivity): ChannelEvent {
  const id = `github_activity:${a.id}`;
  return {
    at: a.at,
    day: localDate(a.at),
    eventId: id,
    matchable: {
      channel: "github_activity",
      isNamedOnly: true,
      repo: a.repo,
      text: a.words,
    },
    payload: {
      at: a.at,
      id,
      kind: a.kind,
      link: a.link,
      number: a.number,
      repo: a.repo,
      source: "github_activity",
      who: a.who,
    },
  };
}

/**
 * The GitHub activity channel over `read` (`githubActivityReader`): the issues, pull requests, comments and reviews of
 * the repos the open waits name, and of no other. Read only in his own Life (`isOn`): `gh` holds his login, which a
 * second Life's agents must never reach.
 * ponytail: a repo's ETag moves on at its read, before its events are queued; a queue that fails then (the desk's own
 * store) loses them. Commit the ETag after the queue if that store ever fails alone.
 */
export const githubActivityChannelOf = (
  read = githubActivityReader(),
  isOn: () => boolean = () => isOwnLife()
): EventChannel => ({
  about:
    "any activity on the GitHub repos you name, a minute or more after it (GitHub's own delay can be longer): its `kind` is `issue.<action>` (opened, closed, reopened, labeled, assigned…; GitHub's repo events carry no edit of an issue's title or body), `pr.<action>` (opened, merged, closed…), `comment`, `review` or `review_comment`; `repo` is required, `owner/name` or `owner/*` (its first 100 repos); `text_matches` tests its title and body when GitHub gives them; read it at its `link` with `gh`",
  // Every poll while a wait names it: the reader paces each repo by GitHub's own interval.
  beat: 0,
  // `gh` failing is the poll's "could not be read" line.
  block: () => (isOn() ? null : "GitHub is read only in his own Life"),
  event: "github.activity",
  hasPoint: false,
  hasRepo: true,
  name: "github_activity",
  quantities: [],
  // Paced from the instant it is read, not the poll's start: a slow channel before it never shortens GitHub's interval.
  read: async (_pollStart, filters = []) =>
    (
      await read(
        filters.flatMap((f) => f.repo ?? []),
        clock().getTime()
      )
    ).map(githubEventOf),
});

export const EVENT_CHANNELS = [
  paymentsChannelOf(payments),
  placesChannelOf(),
  githubActivityChannelOf(),
];
