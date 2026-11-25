import { z } from "zod";
import { clock, DAY, MIN } from "../core/clock";
import { readJson, writeJson } from "../core/files";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { isoDateTime } from "../records/fields";
import type { SourceEvent } from "../records/source";
import { directChats, type WithPeople } from "./closeness";
import { exchangesOf } from "./exchanges";
import { EXCHANGE_COUNTS } from "./memory-files";
import { tables } from "./sources";
import { localDate, time } from "./zones";

// What code counts between him and a person over their one-to-one chats and mail threads (`directChats`), one row per
// exchange (`exchangesOf`). The sources are the truth: the night counts every year again and rewrites one derived file
// (`EXCHANGE_COUNTS`, in Life's state, never his data), so a late backup fill or a late mail is never stale. The one
// counting code: the persona folds the same rows over the messages it is shown.

/** One exchange between him and one person, counted. */
const ExchangeCounts = z
  .object({
    /** The local days it has a message on. */
    days: z.array(z.string()),
    /** Messages they sent, and how many of them they deleted. */
    got: z.int(),
    gotDeleted: z.int(),
    /** Whether he wrote first (else they did). */
    heOpened: z.boolean(),
    /** The local hour (0-23, where he was) of each of his answers, in `hisWaits`' order; a file counted before it has none. */
    hisAnswerHours: z.array(z.int().min(0).max(23)).default([]),
    /** Minutes from their message to his answer, each time he answered inside it. */
    hisWaits: z.array(z.number()),
    sent: z.int(),
    sentDeleted: z.int(),
    start: isoDateTime,
    theirWaits: z.array(z.number()),
  })
  .strict();
export type ExchangeCounts = z.infer<typeof ExchangeCounts>;

/** One person's one-to-one messages, counted exchange by exchange. A call's line counts as a message. */
export function exchangeCountsOf(list: SourceEvent[]): ExchangeCounts[] {
  return exchangesOf(list).flatMap((exchange) => {
    const [first] = exchange;
    if (!first) {
      return [];
    }
    const row: ExchangeCounts = {
      days: [...new Set(exchange.map((e) => localDate(e.at)))],
      got: 0,
      gotDeleted: 0,
      heOpened: !!first.fromMe,
      hisAnswerHours: [],
      hisWaits: [],
      sent: 0,
      sentDeleted: 0,
      start: first.at,
      theirWaits: [],
    };
    let last: SourceEvent | undefined;
    for (const e of exchange) {
      const deleted = e.deleted ? 1 : 0;
      if (e.fromMe) {
        row.sent += 1;
        row.sentDeleted += deleted;
      } else {
        row.got += 1;
        row.gotDeleted += deleted;
      }
      if (last && last.fromMe !== e.fromMe) {
        (e.fromMe ? row.hisWaits : row.theirWaits).push(
          (Date.parse(e.at) - Date.parse(last.at)) / MIN
        );
        if (e.fromMe) {
          row.hisAnswerHours.push(Number(time(e.at).slice(0, 2)));
        }
      }
      last = e;
    }
    return [row];
  });
}

/** What code counts between him and one person over a span of exchanges. */
export interface PairCounts {
  /** Local days with a message. */
  days: number;
  /** Messages each way, and how many of them their writer deleted. */
  got: number;
  gotDeleted: number;
  /** Median minutes from the other's message to an answer inside one exchange, each way; null when none. */
  heAnswersIn: number | null;
  /** Who opened an exchange (`exchangesOf`). */
  heOpened: number;
  sent: number;
  sentDeleted: number;
  theyAnswerIn: number | null;
  theyOpened: number;
}

const median = (xs: number[]) =>
  xs.length > 0
    ? Math.round(xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0)
    : null;

const sum = (rows: ExchangeCounts[], of: (r: ExchangeCounts) => number) =>
  rows.reduce((n, r) => n + of(r), 0);

/**
 * The exchanges of a span folded into its counts. The persona's input hashes this text: the keys keep the order they
 * have had (the first six, then the rest), which a test pins.
 */
export function pairCountsOf(rows: ExchangeCounts[]): PairCounts {
  const c = {
    got: sum(rows, (r) => r.got),
    gotDeleted: sum(rows, (r) => r.gotDeleted),
    heOpened: sum(rows, (r) => Number(r.heOpened)),
    sent: sum(rows, (r) => r.sent),
    sentDeleted: sum(rows, (r) => r.sentDeleted),
    theyOpened: sum(rows, (r) => Number(!r.heOpened)),
  };
  return {
    ...c,
    days: new Set(rows.flatMap((r) => r.days)).size,
    heAnswersIn: median(rows.flatMap((r) => r.hisWaits)),
    theyAnswerIn: median(rows.flatMap((r) => r.theirWaits)),
  };
}

/** The derived file: every person's exchanges counted, when, and from which sources. */
const Stored = z
  .object({
    built: isoDateTime,
    people: z.record(z.string(), z.array(ExchangeCounts)),
    sources: z.array(z.string()),
  })
  .strict();

/**
 * Counts every exchange of everyone from a read of all his years (`readWithPeople(new Date(0))`) and rewrites the file
 * whole. Nothing is written when a source could not be read, or when counting throws (a message with a time no one can
 * read): it is logged, `failed` says so and the last file stands, never a count that misses a source nor a failed night.
 * ponytail: every year is read and counted again each night (about a minute and a half, old mail mostly); keep the rows older than
 * the night's window and read old years only on a first build if that ever costs.
 */
export function writeExchangeCounts(
  { events, failed }: Pick<WithPeople, "events" | "failed">,
  resolve: (s: string) => string | null
) {
  try {
    if (failed.length > 0) {
      throw new Error(`sources failed: ${failed.join(", ")}`);
    }
    const people = Object.fromEntries(
      [...directChats(events, resolve)].map(([ref, list]) => [
        ref,
        exchangeCountsOf(list),
      ])
    );
    writeJson(
      EXCHANGE_COUNTS,
      Stored.parse({
        built: clock().toISOString(),
        people,
        sources: Object.keys(tables().WITH_PEOPLE),
      })
    );
    return { exchanges: Object.values(people).flat().length, failed: 0 };
  } catch (e) {
    log("run.error", {
      ...errorOf(e),
      step: "memory.exchange-counts",
    });
    return { exchanges: 0, failed: 1 };
  }
}

/**
 * The counted exchanges of everyone, or null when the file is missing or in another shape (then there is none).
 * ponytail: the whole file is parsed on each person read (a few MB); an index by person if it ever shows.
 */
export const readExchangeCounts = () =>
  Stored.safeParse(readJson(EXCHANGE_COUNTS)).data ?? null;

/** A ref's last counted exchange (its newest start) in the counts read once; undefined: none counted. */
export const lastExchangeAtOf =
  (counted: ReturnType<typeof readExchangeCounts>) => (ref: string) =>
    (counted?.people[ref] ?? [])
      .map((r) => r.start)
      .toSorted()
      .at(-1);

/** How long his usual answer takes, at least, for a chat to count as one he answers in batches; how many answers say so. */
const BATCHED_AFTER_MIN = 120;
const BATCHED_FROM = 5;
const REPLY_HOUR_DAYS = 90;

/**
 * The local hour he answers a person at, when he answers them in batches: over their exchanges of the last 90 days, at
 * least 5 answers and a median wait of 2 hours or more; then the median of his answers' hours. Else undefined. Pure.
 * ponytail: a plain median of hours (answers either side of midnight pull it to midday); a circular mean if that shows.
 */
export function replyHourOf(rows: readonly ExchangeCounts[], now: Date) {
  const since = new Date(now.getTime() - REPLY_HOUR_DAYS * DAY);
  const recent = rows.filter((r) => Date.parse(r.start) >= since.getTime());
  const hours = recent.flatMap((r) => r.hisAnswerHours);
  const wait = median(recent.flatMap((r) => r.hisWaits));
  return hours.length >= BATCHED_FROM &&
    wait !== null &&
    wait >= BATCHED_AFTER_MIN
    ? (median(hours) ?? undefined)
    : undefined;
}
