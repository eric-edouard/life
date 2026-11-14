import { z } from "zod";
import { clock } from "../core/clock";
import { readJson, writeJson } from "../core/files";
import { log } from "../core/log";
import { isoDateTime } from "../records/fields";
import type { ReadReply } from "../records/read-reply";
import { eventKey, type SourceEvent } from "../records/source";
import type { WithPeople } from "./closeness";
import { READS, readReplies } from "./exchange-reads";
import { MENTIONS } from "./memory-files";
import { checkedOf } from "./moves";
import { dayUnitId, textOf } from "./units";
import { localDate } from "./zones";

// The mentions of the mentions read: someone not in the conversation talked about. The replies are stored
// (`memory/exchange-reads.ts`); the night checks them against the sources once and keeps the result in Life's state
// (`MENTIONS`, never `memory/`), as the exchange counts are kept. A mention holds the words as written and never a
// person: who is meant is worked out when read (`placementOf`, `memory/who.ts`), so a fold or a name given later moves it.

/** One mention: `who` as the model wrote it, `quote` the words on the message `line` (its text), said by `by` as the source names the sender. */
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
    /** By local day, so a reader of one day takes only its list. */
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
                by: message.sender,
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
 * the file whole. Like the exchange counts: nothing is written when a source could not be read, or when checking
 * throws; it is logged, `failed` says so and the last file stands.
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
    writeJson(
      MENTIONS,
      Stored.parse({
        built: clock().toISOString(),
        days: Object.fromEntries(Map.groupBy(mentions, (m) => localDate(m.at))),
      })
    );
    return { failed: 0, mentions: mentions.length };
  } catch (e) {
    log("run.error", {
      error: (e as Error).message,
      step: "memory.mentions",
    });
    return { failed: 1, mentions: 0 };
  }
}

/**
 * The kept mentions by local day, or null when the file is missing or in another shape (then there is none).
 * ponytail: the whole file is parsed on each read; one file a month if it ever shows.
 */
export const readMentions = () =>
  Stored.safeParse(readJson(MENTIONS)).data?.days ?? null;
