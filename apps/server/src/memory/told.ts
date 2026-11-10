import { join } from "node:path";
import { z } from "zod";
import { clock } from "../core/clock";
import { appendJsonl, readAppended } from "../core/files";
import { isoDateTime } from "../records/fields";
import type { SourceEvent } from "../records/source";
import type { Newest } from "../sources/contract";
import { MEMORY } from "./ledger";

// What he told Life in a chat with ChatGPT or Claude (`tell_life`, the connector): his words, verbatim, and the question
// he answered, if any. Append-only, one synchronous line each, outside the lock like a correction. Read back as the
// source `told`: his lines marked (kept, never weighed), a question as the assistant's line, never his.

export const TOLD = join(MEMORY, "told.jsonl");

const Told = z
  .object({
    asked: z.string().min(1).optional(),
    at: isoDateTime,
    said: z.string().min(1),
    schemaVersion: z.literal(1),
  })
  .strict();
type Told = z.infer<typeof Told>;

/** Who asks in a told line: the chat's assistant, never a person. */
const ASSISTANT = "assistant";

/** Appends what he told Life, stamped now. */
export function recordTold(said: string, asked?: string) {
  const line: Told = {
    ...(asked ? { asked } : {}),
    at: clock().toISOString(),
    said,
    schemaVersion: 1,
  };
  appendJsonl(TOLD, Told, [line]);
  return line;
}

const readAll = () =>
  readAppended(
    TOLD,
    Told,
    (last?: Told[]) => last ?? [],
    (all, t) => {
      all.push(t);
    }
  );

/** The status snapshot's card: when he last told Life something. */
export const newestTold = (): Newest => ({ at: readAll().at(-1)?.at ?? null });

/** The first timestamp in the read-once told cache. */
export const readEarliestTold = () =>
  readAll()
    .map((t) => t.at)
    .sort()[0] ?? null;

/** What he told Life since `since`: his words marked, each question as the assistant's line just before. */
export function readTold(since: Date, before?: Date): SourceEvent[] {
  return readAll().flatMap((t): SourceEvent[] => {
    if (
      Date.parse(t.at) < since.getTime() ||
      (before && Date.parse(t.at) >= before.getTime())
    ) {
      return [];
    }
    const base = { at: t.at, chat: "told", chatName: "Told Life" };
    const said: SourceEvent = {
      ...base,
      fromMe: true,
      id: `told:${t.at}`,
      marked: true,
      sender: "me",
      source: "told",
      text: t.said,
    };
    return t.asked
      ? [
          {
            ...base,
            fromMe: false,
            id: `told:${t.at}#asked`,
            sender: ASSISTANT,
            source: "told",
            text: t.asked,
          },
          said,
        ]
      : [said];
  });
}
