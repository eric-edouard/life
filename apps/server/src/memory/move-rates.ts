import type { z } from "zod";
import type { ReadName } from "../records/read-reply";
import { eventKey, type SourceEvent } from "../records/source";
import {
  BIDS,
  type CheckedExchange,
  type Code,
  MOVES,
  type Move,
  type SeenExchange,
  type Side,
} from "./moves";
import { folded } from "./observe";
import { localDate } from "./zones";

// How often each thing a person did turns up, from the moves the reads listed (`memory/moves.ts`): rows of `n` of
// `of` chances, per side, all time, the last 12 months and before. Pure: it counts the exchanges it is given, and
// stores nothing. A share is said only for what the test set proved (`PROVEN`) and only over `MINIMUM` chances.

/** How a bid was met, by the other side: toward it, away from it, against it, or not at all. */
type Met = "toward" | "away" | "against" | "unanswered";
/** Everything counted: each code, how a bid was met, warm tone, and the exchange's tension and conflict flags. */
export type Thing = Code | Met | "warm" | "tension" | "conflict";
/**
 * What a rate is a share of: `exchange`, the exchanges that side wrote in (a flag: every exchange), which its read
 * saw; `bid`, the bids the other side made; `fault`, the exchanges the conflict read saw where the other side
 * raised a fault; `decision`, those holding any steering code by either side.
 */
export type Chance = "exchange" | "bid" | "fault" | "decision";

const chance = <T extends Thing>(is: Chance, ...things: T[]) =>
  Object.fromEntries(things.map((t) => [t, is])) as Record<T, Chance>;
/** The chance of every thing counted. */
export const CHANCE: Record<Thing, Chance> = {
  ...chance(
    "exchange",
    "shares",
    "good_news",
    "support_asked",
    "invites",
    "reassurance_asked",
    "discloses",
    "asks_for",
    "offers",
    "gives",
    "refuses",
    "returns",
    "asks_about",
    "thanks",
    "affection",
    "support_given",
    "explores",
    "mention",
    "feels",
    "intends",
    "wants",
    "believes",
    "fault",
    "contempt",
    "presses",
    "blames",
    "distress",
    "warm",
    "tension",
    "conflict"
  ),
  ...chance("bid", "toward", "away", "against", "unanswered"),
  ...chance(
    "fault",
    "engages",
    "apologises",
    "excuses",
    "denies",
    "counters",
    "yields",
    "moves_on"
  ),
  ...chance("decision", "directs", "proposes", "defers", "decides"),
};

/** Under this many chances a rate says "too few" (spec 9). A reading's own higher bar is its reader's. */
const MINIMUM = 15;

const both = (...things: Thing[]) =>
  things.flatMap((t) => [`${t}|me`, `${t}|them`]);
/**
 * What a share may be said of, as `thing|side` (a flag has no side): the test sets of 13 Nov 2026, against the
 * reference model: kappa 0.5 or more on 30 cases or more. Everything else is exploratory: counted, never a share.
 */
export const PROVEN = new Set<string>([
  ...both(
    "affection",
    "asks_about",
    "asks_for",
    "discloses",
    "gives",
    "invites",
    "offers",
    "shares",
    "support_given",
    "thanks",
    "feels",
    "intends",
    "mention",
    "decides",
    "directs",
    "fault",
    "proposes",
    "warm",
    "toward",
    "explores",
    "good_news",
    "defers",
    "presses"
  ),
  "apologises|me",
  "denies|me",
  "excuses|me",
  "reassurance_asked|them",
  "refuses|me",
  "believes|them",
  "wants|them",
  "tension",
  "conflict",
]);

/** The read of every code, worked out from the shapes in `MOVES`. */
const CODE_READ = Object.fromEntries(
  Object.entries(MOVES).flatMap(([read, union]) =>
    (union.options as z.ZodObject<{ code: z.ZodType<string> }>[]).flatMap(
      (o) => {
        const { code } = o.shape as unknown as {
          code: { options?: string[]; value?: string };
        };
        return (code.options ?? [code.value]).map((c) => [c, read]);
      }
    )
  )
) as Record<Code, ReadName>;
const readOf = (thing: Thing): ReadName => {
  if (thing === "conflict") {
    return "conflict";
  }
  return thing in CODE_READ ? CODE_READ[thing as Code] : "connection";
};

const STEERING = (Object.keys(CHANCE) as Thing[]).filter(
  (t) => CHANCE[t] === "decision"
);
const isBid = (code: Code) => (BIDS as readonly string[]).includes(code);
const SIDES: Side[] = ["me", "them"];
const otherOf = (side: Side): Side => (side === "me" ? "them" : "me");

/**
 * The moves that count as one each: the first of a code by a side, and a mention once per person talked about. A
 * person who shares twice in an exchange shared.
 */
export function votesOf(moves: Move[]) {
  const seen = new Set<string>();
  return moves.filter((m) => {
    const vote = `${m.by}|${m.code}|${m.who ? folded(m.who).out : ""}`;
    return seen.has(vote) ? false : !!seen.add(vote);
  });
}

/** An exchange with the votes of its moves, worked out once, and the month it began in. */
interface Prepared {
  month: string;
  votes: Move[];
  x: SeenExchange;
}
interface Count {
  n: number;
  of: number;
}

const NONE: Count = { n: 0, of: 0 };
const one = (taken: boolean): Count => ({ n: taken ? 1 : 0, of: 1 });
const did = (votes: Move[], side: Side, code: Thing) =>
  votes.some((m) => m.by === side && m.code === code);

/** The chance of an exchange chance: the exchange, if the side wrote in it (a flag has no side). */
function exchangeIn(thing: Thing, side: Side | undefined, p: Prepared): Count {
  const { votes, x } = p;
  if (thing === "conflict" || thing === "tension") {
    return x[thing] === undefined ? NONE : one(!!x[thing]);
  }
  if (!(side && x.took.has(side))) {
    return NONE;
  }
  if (thing === "warm") {
    const tone = x.tone[side];
    return tone ? one(tone === "warm") : NONE;
  }
  return one(did(votes, side, thing));
}

/** What one exchange adds to a rate of `thing` by `side`: chances, and the ones taken. */
function chancesIn(thing: Thing, side: Side | undefined, p: Prepared): Count {
  const { votes, x } = p;
  if (!x.reads.has(readOf(thing))) {
    return NONE;
  }
  switch (CHANCE[thing]) {
    case "bid": {
      const bids = votes.filter(
        (m) => m.by === otherOf(side as Side) && isBid(m.code)
      );
      const met = (m: Move) => (m.answer?.kind ?? "unanswered") === thing;
      return { n: bids.filter(met).length, of: bids.length };
    }
    case "fault":
      return did(votes, otherOf(side as Side), "fault")
        ? one(did(votes, side as Side, thing))
        : NONE;
    case "decision":
      return STEERING.some((c) => did(votes, "me", c) || did(votes, "them", c))
        ? one(did(votes, side as Side, thing))
        : NONE;
    default:
      return exchangeIn(thing, side, p);
  }
}

/** What a count says: a share, too few chances for one, or a thing not proven on the test set. */
type Says = "share" | "too few" | "exploratory";
/** A count of `n` in `of` chances, and what it says. */
export interface Rate extends Count {
  says: Says;
}
/** A row: one thing by one side (a flag has none), for one source when its chance is an exchange. */
export interface MoveRate {
  all: Rate;
  before: Rate;
  lately: Rate;
  side?: Side;
  source?: string;
  thing: Thing;
}

/** One row: a thing, by a side and from a source (or neither), over every exchange, split by month. */
function rowOf(
  thing: Thing,
  side: Side | undefined,
  source: string | undefined,
  prepared: Prepared[],
  month: string
): MoveRate[] {
  const since = `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`;
  const total = { all: { ...NONE }, before: { ...NONE }, lately: { ...NONE } };
  for (const p of prepared) {
    if (source && p.x.source !== source) {
      continue;
    }
    const c = chancesIn(thing, side, p);
    let span = total.lately;
    if (p.month < since) {
      span = total.before;
    }
    for (const t of p.month < month ? [total.all, span] : [total.all]) {
      t.n += c.n;
      t.of += c.of;
    }
  }
  const proven = PROVEN.has(side ? `${thing}|${side}` : thing);
  const rate = ({ n, of }: Count): Rate => {
    if (!proven) {
      return { n, of, says: "exploratory" };
    }
    return { n, of, says: of < MINIMUM ? "too few" : "share" };
  };
  return total.all.of === 0
    ? []
    : [
        {
          all: rate(total.all),
          before: rate(total.before),
          lately: rate(total.lately),
          side,
          source,
          thing,
        },
      ];
}

/**
 * The rates of what a person did, from the exchanges seen: a row for each thing and side with a chance, and for an
 * exchange chance one row per source, never pooled (a bid, a fault or a decision is counted across sources). Each
 * has all time, the 12 local months before `month` (`YYYY-MM`, the caller's, so people compare over one window) and
 * the time before those.
 */
export function moveRatesOf(seen: SeenExchange[], month: string): MoveRate[] {
  const prepared = seen.map(
    (x): Prepared => ({
      month: localDate(x.at).slice(0, 7),
      votes: votesOf(x.moves),
      x,
    })
  );
  const sources = [...new Set(seen.map((x) => x.source))];
  return (Object.keys(CHANCE) as Thing[]).flatMap((thing) => {
    const sides =
      thing === "conflict" || thing === "tension" ? [undefined] : SIDES;
    const from = CHANCE[thing] === "exchange" ? sources : [undefined];
    return sides.flatMap((side) =>
      from.flatMap((source) => rowOf(thing, side, source, prepared, month))
    );
  });
}

/**
 * Where a rate stands among the same rate of others: how many of those with a share are above it and how many
 * below; a tie counts as neither. A rate with no share has no place.
 */
export function placeAmong(rate: Rate, others: Rate[]) {
  const place = { above: 0, below: 0 };
  if (rate.says !== "share") {
    return place;
  }
  for (const o of others) {
    if (o.says === "share") {
      const diff = o.n * rate.of - rate.n * o.of;
      place.above += diff > 0 ? 1 : 0;
      place.below += diff < 0 ? 1 : 0;
    }
  }
  return place;
}

/** One read of some calls, as `checkedMoves` gave it: the exchanges it checked and the messages they are in. */
export interface ReadOfCalls {
  checked: CheckedExchange[];
  messages: SourceEvent[];
  read: ReadName;
  starts: number[];
}

/**
 * The exchanges every read saw, merged by their first message (`eventKey`): its moves from all the reads, each flag
 * and tone from the read that gave it, who wrote in it (a call line is no one's writing), and which reads saw it.
 * In time order.
 */
export function seenExchanges(reads: ReadOfCalls[]): SeenExchange[] {
  const merged = new Map<string, SeenExchange>();
  for (const { checked, messages, read, starts } of reads) {
    for (const x of checked) {
      const first = messages[x.exchange];
      if (!first) {
        continue;
      }
      const end = starts[starts.indexOf(x.exchange) + 1] ?? messages.length;
      const key = eventKey(first);
      const seen = merged.get(key) ?? {
        at: first.at,
        key,
        moves: [],
        reads: new Set<ReadName>(),
        source: first.source,
        tone: {},
        took: new Set<Side>(
          messages
            .slice(x.exchange, end)
            .filter((m) => !m.phoneCall)
            .map((m): Side => (m.fromMe ? "me" : "them"))
        ),
      };
      merged.set(key, seen);
      seen.reads.add(read);
      seen.moves.push(...x.moves);
      seen.conflict ??= x.conflict;
      seen.tension ??= x.tension;
      seen.tone = {
        me: x.tone.me ?? seen.tone.me,
        them: x.tone.them ?? seen.tone.them,
      };
    }
  }
  return [...merged.values()].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at)
  );
}
