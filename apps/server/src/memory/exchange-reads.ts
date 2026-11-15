import { newestWithin } from "../core/lists";
import { MOVE_READS } from "../records/read-reply";
import { chatGroups, eventKey, type SourceEvent } from "../records/source";
import { directChats, type WithPeople } from "./closeness";
import {
  batchesOf,
  batchLines,
  exchangesOf,
  isFinished,
  isTwoWay,
} from "./exchanges";
import { READ_REPLIES } from "./memory-files";
import {
  type Asked,
  makeReplies,
  READS,
  readReplyIndex,
  replyOf,
} from "./read-replies";
import { begin } from "./run";
import type { People } from "./who";

// The exchange reads (docs/glossary.md): three reads of every finished exchange of a person's two-way one-to-one chats,
// each reply stored by `memory/read-replies.ts`; the moves are worked out from it when read (`checkedMoves`), never
// stored. Off until his `exchangeReads` setting, which gates the calls and never the reading of what is stored.

/** The most calls a night makes across the three reads: a first build takes several nights, the newest first. */
const NIGHT_CALLS = 200;

/** Who a person is, as a read is told: their name and what they are to him in his directory. */
export interface With {
  name: string;
  relation: string | null;
}
export const withOf = (known: string, people: People): With => ({
  name: people.nameOf(`person:${known}`),
  relation: people.truth.people.find((p) => p.id === known)?.relation ?? null,
});

/** One call: what the model is shown, the key of each message its lines are, and where each exchange starts in them. */
export function callOf(batch: SourceEvent[][], withWhom: With) {
  const { lines, messages, starts } = batchLines(batch, (e) =>
    e.fromMe ? "me" : withWhom.name
  );
  return {
    firstAt: messages[0]?.at ?? "",
    input: { lines, with: withWhom },
    keys: messages.map(eventKey),
    starts,
  };
}

export type ExchangeReadWork = ReturnType<typeof readExchangeReadWork>;

/**
 * What the exchange reads have to ask, from a read of every year (`readWithPeople(new Date(0))`): for each person's
 * two-way one-to-one chats, the finished exchanges a read has no stored reply for, batched per chat (`batchesOf`),
 * the newest calls first up to `NIGHT_CALLS`. Null when a source failed (an exchange must never be read without
 * one). `counts` is the whole of what is pending, before the cap: what a run would cost.
 */
export function readExchangeReadWork(
  { events, failed }: Pick<WithPeople, "events" | "failed">,
  people: People,
  now: Date,
  where = READ_REPLIES
) {
  if (failed.length > 0) {
    return null;
  }
  const index = readReplyIndex(where);
  const pending: Asked[] = [];
  for (const [ref, messages] of directChats(events, people.resolve)) {
    if (!ref.startsWith("person:")) {
      continue;
    }
    const withWhom = withOf(ref.slice("person:".length), people);
    for (const chat of chatGroups(messages).values()) {
      const finished = isTwoWay(chat)
        ? exchangesOf(chat).filter((x) => isFinished(x, now))
        : [];
      for (const read of MOVE_READS) {
        const unread = finished.filter(
          (x) => !replyOf(x.map(eventKey), read, index)
        );
        for (const batch of batchesOf(unread)) {
          pending.push({
            at: batch.at(-1)?.[0]?.at ?? "",
            call: callOf(batch, withWhom),
            read,
          });
        }
      }
    }
  }
  return {
    counts: {
      calls: pending.length,
      exchanges: pending.reduce((n, p) => n + p.call.starts.length, 0),
    },
    work: newestWithin(pending, NIGHT_CALLS, {
      at: (p) => p.at,
      size: () => 1,
    }),
  };
}

/** The night's exchange reads: what is due (`readExchangeReadWork`), asked and stored. A failure costs that call only. */
export async function exchangeReads(pending: NonNullable<ExchangeReadWork>) {
  const step = await begin("exchange-reads", "main", {
    prompts: MOVE_READS.map((r) => READS[r].prompt),
  });
  return step.end({
    calls: pending.work.length,
    stored: (await makeReplies(pending.work, step)).stored,
  });
}
