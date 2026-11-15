import { existsSync, readdirSync, rmSync } from "node:fs";
import { z } from "zod";
import { clock } from "../core/clock";
import { readJson, writeJson } from "../core/files";
import { log } from "../core/log";
import type { Episode } from "../records/episode";
import { isoDateTime } from "../records/fields";
import type { ReadReply } from "../records/read-reply";
import { eventKey, type SourceEvent } from "../records/source";
import type { WithPeople } from "./closeness";
import { READS, readReplies } from "./exchange-reads";
import { MENTIONS, mentionsPath } from "./memory-files";
import { checkedOf } from "./moves";
import { OWNER } from "./read-truth";
import { dayUnitId, textOf } from "./units";
import { localDate } from "./zones";

// The mentions of the mentions read: someone not in the conversation talked about. The replies are stored
// (`memory/exchange-reads.ts`); the night checks them against the sources once and keeps the result in Life's state
// (`MENTIONS`, never `memory/`), as the exchange counts are kept. A mention holds the words as written and never a
// person: who is meant is worked out when read (`placementOf`, `memory/who.ts`), so a fold or a name given later moves it.

/** One mention: `who` as the model wrote it, `quote` the words on the message `line` (its text), said by `by`: `OWNER` when he sent it, else the sender as the source names it. */
const Mention = z
  .object({
    at: isoDateTime,
    by: z.string(),
    line: z.string(),
    quote: z.string(),
    unit: z.string(),
    who: z.string(),
  })
  .strict();
export type Mention = z.infer<typeof Mention>;

const Stored = z
  .object({
    built: isoDateTime,
    /** By local day, those of the file's month. */
    days: z.record(z.string(), z.array(Mention)),
  })
  .strict();

/**
 * Every mention the stored replies of the current mentions prompt hold, checked against `events` (by key), oldest
 * first (an exchange read again after it grew counts once: `checkedOf`).
 */
export function mentionsOf(
  lines: ReadReply[],
  events: Map<string, SourceEvent>
): Mention[] {
  const current = lines.filter(
    (l) => l.madeBy.prompt === READS.mentions.prompt
  );
  return [...checkedOf(current, "mentions", events).values()]
    .flatMap((x) =>
      x.moves.flatMap((m) => {
        const message = x.messages[m.line];
        return m.code === "mention" && m.who && message
          ? [
              {
                at: message.at,
                by: message.fromMe ? OWNER : message.sender,
                line: textOf(message),
                quote: m.quote,
                unit: dayUnitId(message),
                who: m.who,
              },
            ]
          : [];
      })
    )
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Keeps the mentions of the stored replies, from a read of all his years (`readWithPeople(new Date(0))`), and rewrites
 * the month files whole. Like the exchange counts: nothing is written when a source could not be read, or when checking
 * throws; it is logged, `failed` says so and the last files stand.
 */
export function writeMentions({
  events,
  failed,
}: Pick<WithPeople, "events" | "failed">) {
  try {
    if (failed.length > 0) {
      throw new Error(`sources failed: ${failed.join(", ")}`);
    }
    const mentions = mentionsOf(
      readReplies().flat(),
      new Map(events.map((e) => [eventKey(e), e]))
    );
    const built = clock().toISOString();
    const byMonth = Map.groupBy(
      [...Map.groupBy(mentions, (m) => localDate(m.at))],
      ([day]) => day.slice(0, 7)
    );
    for (const [month, days] of byMonth) {
      writeJson(
        mentionsPath(month),
        Stored.parse({ built, days: Object.fromEntries(days) })
      );
    }
    // A month no mention is left in goes.
    for (const month of monthsKept().filter((m) => !byMonth.has(m))) {
      rmSync(mentionsPath(month));
    }
    return { failed: 0, mentions: mentions.length };
  } catch (e) {
    log("run.error", {
      error: (e as Error).message,
      step: "memory.mentions",
    });
    return { failed: 1, mentions: 0 };
  }
}

const monthsKept = () =>
  existsSync(MENTIONS)
    ? readdirSync(MENTIONS)
        .filter((n) => n.endsWith(".json"))
        .map((n) => n.slice(0, -".json".length))
    : [];

/**
 * The kept mentions by local day, of these months (`YYYY-MM`) or all of them, or null when there are none.
 */
export function readMentions(months = monthsKept()) {
  const days = Object.assign(
    {},
    ...months.map((m) => Stored.safeParse(readJson(mentionsPath(m))).data?.days)
  ) as Record<string, Mention[]>;
  return Object.keys(days).length > 0 ? days : null;
}

/** The mentions kept for one local day: one month's file is parsed, never every year's. */
export const readMentionsOn = (day: string) =>
  readMentions([day.slice(0, 7)])?.[day] ?? [];

/**
 * The people an episode's units had talked about, in the order first named: whom `place` says each mention means, less
 * those taking part in it (`refOf` as of today) and him. Worked out when read and shown by `day()` only: the memory
 * line (`episodeText`) never holds it.
 */
export function talkedAboutOf(
  episode: Pick<Episode, "people" | "units">,
  mentions: Mention[],
  place: (mention: Mention) => string | undefined,
  refOf: (ref: string) => string
) {
  const out = new Set([OWNER, ...episode.people.map((p) => refOf(p.ref))]);
  const about = new Set<string>();
  for (const m of mentions) {
    const ref = episode.units.includes(m.unit) ? place(m) : undefined;
    if (ref && !out.has(ref)) {
      about.add(ref);
    }
  }
  return [...about];
}
