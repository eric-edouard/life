import { z } from "zod";
import { isoDateTime, MadeBy } from "./fields";

// A stored read reply (memory/read-replies/<YYYY-MM>.jsonl, the month of its first message, docs/SCHEMA.md): what a model answered when it read
// exchanges of a one-to-one chat, as given.

/** The three reads of an exchange; the shape of each one's moves is `MOVES` (`memory/moves.ts`). */
export const READ_NAMES = ["conflict", "connection", "mentions"] as const;
export type ReadName = (typeof READ_NAMES)[number];

/**
 * One call's reply, a line of the file: the reply as the model gave it (only its `exchanges` list is required, the
 * rest is checked when read, `checkedMoves`), the `eventKey` of every message the call showed in order (`messages`),
 * where each exchange starts in them (`starts`), the prompt's name in `madeBy.prompt` and the digest of its text
 * (`promptDigest`). The person and the moves are never stored.
 */
export const ReadReply = z
  .object({
    at: isoDateTime,
    madeBy: MadeBy,
    messages: z.array(z.string().min(1)).min(1),
    promptDigest: z.string().regex(/^[0-9a-f]{16}$/),
    read: z.enum(READ_NAMES),
    reply: z.looseObject({ exchanges: z.array(z.unknown()) }),
    schemaVersion: z.literal(1),
    starts: z.array(z.int().min(0)).min(1),
  })
  .strict();
export type ReadReply = z.infer<typeof ReadReply>;
