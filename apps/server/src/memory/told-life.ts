import { join } from "node:path";
import { z } from "zod";
import { clock } from "../core/clock";
import { appendJsonl, readAppended } from "../core/files";
import { isoDateTime } from "../records/fields";
import type { SourceEvent } from "../records/source";
import type { Newest } from "../sources/contract";
import { MEMORY } from "./memory-files";

// What he told Life in a chat with ChatGPT or Claude (`tell_life`, the connector): his words, verbatim, and the question
// he answered, if any. Append-only, one synchronous line each, outside the lock like a correction. Read back as the
// source `told-life`: his lines marked (kept, never weighed), a question as the assistant's line, never his.

export const TOLD_LIFE = join(MEMORY, "told-life.jsonl");

const ToldLife = z
  .object({
    asked: z.string().min(1).optional(),
    at: isoDateTime,
    said: z.string().min(1),
    schemaVersion: z.literal(1),
  })
  .strict();
type ToldLife = z.infer<typeof ToldLife>;

/** Who asks in a told line: the chat's assistant, never a person. */
const ASSISTANT = "assistant";

/** Appends what he told Life, stamped now. */
export function recordToldLife(said: string, asked?: string) {
  const line: ToldLife = {
    ...(asked ? { asked } : {}),
    at: clock().toISOString(),
    said,
    schemaVersion: 1,
  };
  appendJsonl(TOLD_LIFE, ToldLife, [line]);
  return line;
}

const readAll = () =>
  readAppended(
    TOLD_LIFE,
    ToldLife,
    (last?: ToldLife[]) => last ?? [],
    (all, t) => {
      all.push(t);
    }
  );

/** The status snapshot's card: when he last told Life something. */
export const newestToldLife = (): Newest => ({
  at: readAll().at(-1)?.at ?? null,
});

/** The first timestamp in the read-once told cache. */
export const readEarliestToldLife = () =>
  readAll()
    .map((t) => t.at)
    .sort()[0] ?? null;

/** What he told Life since `since`: his words marked, each question as the assistant's line just before. */
export function readToldLife(since: Date, before?: Date): SourceEvent[] {
  return readAll().flatMap((t): SourceEvent[] => {
    if (
      Date.parse(t.at) < since.getTime() ||
      (before && Date.parse(t.at) >= before.getTime())
    ) {
      return [];
    }
    const base = { at: t.at, chat: "told-life", chatName: "Told Life" };
    const said: SourceEvent = {
      ...base,
      fromMe: true,
      id: `told-life:${t.at}`,
      marked: true,
      sender: "me",
      source: "told-life",
      text: t.said,
    };
    return t.asked
      ? [
          {
            ...base,
            fromMe: false,
            id: `told-life:${t.at}#asked`,
            sender: ASSISTANT,
            source: "told-life",
            text: t.asked,
          },
          said,
        ]
      : [said];
  });
}
