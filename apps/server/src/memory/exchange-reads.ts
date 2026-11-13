import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { clock } from "../core/clock";
import { appendJsonl, readAppended } from "../core/files";
import { digest } from "../core/hash";
import { newestWithin } from "../core/lists";
import { promptText, stamp } from "../models/llm";
import { READ_NAMES, type ReadName, ReadReply } from "../records/read-reply";
import { chatGroups, eventKey, type SourceEvent } from "../records/source";
import { directChats, type WithPeople } from "./closeness";
import { batchesOf, exchangesOf, isFinished, isLiving } from "./exchanges";
import { READ_REPLIES, readReplyPath } from "./ledger";
import { begin, inBatches, type Step } from "./run";
import type { People } from "./who";
import { batchLines } from "./words";

// The exchange reads (docs/glossary.md): three reads of every finished exchange of a person's living one-to-one chats,
// each reply stored as the model gave it in memory/read-replies/ (model output is expensive); the moves are worked out
// from it when read (`checkedMoves`), never stored. What is pending is derived each night from the stored lines
// (`replyOf`). Off until his `exchangeReads` setting, which gates the calls and never the reading of what is stored.

/** The prompt of each read; its moves' shape is `MOVES`, `memory/moves.ts`. */
export const READS = {
  conflict: { prompt: "memory-conflict.v2" },
  connection: { prompt: "memory-connection.v3" },
  mentions: { prompt: "memory-mentions.v1" },
} satisfies Record<ReadName, { prompt: string }>;
/** The most calls a night makes across the three reads: a first build takes several nights, the newest first. */
const NIGHT_CALLS = 200;

/** Who a person is, as a read is told: their name and what they are to him on his map. */
export interface With {
  name: string;
  relation: string | null;
}
export const withOf = (known: string, people: People): With => ({
  name: people.nameOf(`person:${known}`),
  relation: people.truth.people.find((p) => p.id === known)?.relation ?? null,
});

/** One call: what the model is shown, the messages its lines are, and where each exchange starts in them. */
export function callOf(batch: SourceEvent[][], withWhom: With) {
  const { lines, messages, starts } = batchLines(batch, (e) =>
    e.fromMe ? "me" : withWhom.name
  );
  return { input: { lines, with: withWhom }, messages, starts };
}
export type Call = ReturnType<typeof callOf>;

/** A call to make, with the instant of its newest exchange (the night asks the newest first). */
export interface Asked {
  at: string;
  call: Call;
  read: ReadName;
}

/** The files replies are kept in: memory's folder of month files, or else one trial file (`scripts/memory-pilot.ts`). */
const filesOf = (where: string) => {
  if (where !== READ_REPLIES) {
    return [where];
  }
  return existsSync(where)
    ? readdirSync(where)
        .filter((n) => n.endsWith(".jsonl"))
        .sort()
        .map((n) => join(where, n))
    : [];
};

/** The stored lines of each file of `where`, oldest first; a file is read by `readAppended` (its new lines only). */
export const readReplies = (where = READ_REPLIES) =>
  filesOf(where).map((file) =>
    readAppended(
      file,
      ReadReply,
      (last?: ReadReply[]) => [...(last ?? [])],
      (all, line) => {
        all.push(line);
      }
    )
  );

/** A stored exchange: its place in the line that read it, and the keys of its messages. */
interface Held {
  index: number;
  keys: string[];
  line: ReadReply;
}
type ReplyIndex = Record<ReadName, Map<string, Held[]>>;
const indexes = new Map<string, { index: ReplyIndex; parts: ReadReply[][] }>();

/**
 * The stored exchanges of each read by their first message's key, from the lines made by the read's current prompt
 * (its versioned name: a version changes only when the meaning does, so the digest is never matched on). Built once,
 * and again only when a file grew.
 */
export function readReplyIndex(where = READ_REPLIES) {
  const parts = readReplies(where);
  const kept = indexes.get(where);
  if (
    kept?.parts.length === parts.length &&
    kept.parts.every((p, i) => p === parts[i])
  ) {
    return kept.index;
  }
  const index = Object.fromEntries(
    READ_NAMES.map((r) => [r, new Map<string, Held[]>()])
  ) as ReplyIndex;
  for (const line of parts.flat()) {
    if (line.madeBy.prompt === READS[line.read].prompt) {
      for (const [i, start] of line.starts.entries()) {
        const keys = line.messages.slice(start, line.starts[i + 1]);
        const first = keys[0] ?? "";
        index[line.read].set(first, [
          ...(index[line.read].get(first) ?? []),
          { index: i, keys, line },
        ]);
      }
    }
  }
  indexes.set(where, { index, parts });
  return index;
}

/**
 * What `read` stored for an exchange: the newest line of the read's current prompt that lists it with exactly the
 * messages it has now (a line that read it before it grew or was filled does not match). Decides both "pending" and
 * "counted"; undefined when it was never read. An exchange the model skipped in a reply it was asked is still read.
 */
export function replyOf(
  exchange: SourceEvent[],
  read: ReadName,
  index = readReplyIndex()
) {
  const keys = exchange.map(eventKey);
  return index[read]
    .get(keys[0] ?? "")
    ?.findLast(
      (h) =>
        h.keys.length === keys.length && h.keys.every((k, i) => k === keys[i])
    );
}

export type ExchangeReadWork = ReturnType<typeof readExchangeReadWork>;

/**
 * What the exchange reads have to ask, from a read of every year (`readWithPeople(new Date(0))`): for each person's
 * living one-to-one chats, the finished exchanges a read has no stored reply for, batched per chat (`batchesOf`),
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
      const finished = isLiving(chat)
        ? exchangesOf(chat).filter((x) => isFinished(x, now))
        : [];
      for (const read of READ_NAMES) {
        const unread = finished.filter((x) => !replyOf(x, read, index));
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

/**
 * Makes each call, a few at a time, and stores its reply as the model gave it, with what made it (`madeBy`), the
 * digest of the prompt's text and the keys of the messages it read. A call that fails, or a reply that is not one (an
 * object with its `exchanges`), stores nothing and is asked again at the next pass.
 */
export async function makeReplies(
  asked: Asked[],
  step: Pick<Step, "ask" | "attempt" | "dir" | "llm" | "run">,
  where = READ_REPLIES
) {
  const wordings = Object.fromEntries(
    await Promise.all(
      READ_NAMES.map(async (r) => [
        r,
        digest("sha256", await promptText(READS[r].prompt), 16),
      ])
    )
  );
  let stored = 0;
  await inBatches(asked, step, async ({ call, read }, dir) => {
    await step.attempt(
      async () => {
        const { prompt } = READS[read];
        const reply = await step.ask({ dir, input: call.input, prompt });
        const at = clock().toISOString();
        appendJsonl(
          where === READ_REPLIES ? readReplyPath(at) : where,
          ReadReply,
          [
            {
              at,
              madeBy: stamp(step.llm, prompt, step.run),
              messages: call.messages.map(eventKey),
              read,
              reply: reply as ReadReply["reply"],
              schemaVersion: 1,
              starts: call.starts,
              wording: wordings[read] as string,
            },
          ]
        );
        stored += 1;
      },
      { read }
    );
  });
  return { stored };
}

/** The night's exchange reads: what is due (`readExchangeReadWork`), asked and stored. A failure costs that call only. */
export async function exchangeReads(pending: NonNullable<ExchangeReadWork>) {
  const step = await begin("exchange-reads", "main", {
    prompts: Object.values(READS).map((r) => r.prompt),
  });
  return step.end({
    ...(await makeReplies(pending.work, step)),
    calls: pending.work.length,
  });
}
