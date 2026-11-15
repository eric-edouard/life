import { z } from "zod";
import { isoDateTime, MadeBy } from "./fields";

// A stored read reply (memory/read-replies/<YYYY-MM>.jsonl, the month of its first message, docs/SCHEMA.md): what a model answered when it read
// exchanges of a one-to-one chat, as given.

/** The three reads of exchanges (the moves reads); the shape of each one's moves is `MOVES` (`memory/moves.ts`). */
export const MOVE_READS = ["conflict", "connection", "mentions"] as const;
export type MoveRead = (typeof MOVE_READS)[number];

/** The read that summarises a conversation recorded in person (`memory/conversation-summaries.ts`). */
export const SUMMARY_READ = "conversation_summary" as const;
/** Every read whose replies are stored. */
export type ReadName = MoveRead | typeof SUMMARY_READ;

/**
 * One call's reply, a line of the file: the reply as the model gave it (a moves read only needs its `exchanges` list,
 * the summary its `summary`, the rest is checked when read), the key of every message the call showed in order
 * (`messages`: `eventKey`, or `turnKey` for speech), where each item starts in them (`starts`: each exchange, or `[0]`
 * for a summary), the prompt's name in `madeBy.prompt` and the digest of its text (`promptDigest`). The person and the
 * moves are never stored.
 */
const stored = {
  at: isoDateTime,
  madeBy: MadeBy,
  messages: z.array(z.string().min(1)).min(1),
  promptDigest: z.string().regex(/^[0-9a-f]{16}$/),
  schemaVersion: z.literal(1),
  starts: z.array(z.int().min(0)).min(1),
};
export const MoveReply = z
  .object({
    ...stored,
    read: z.enum(MOVE_READS),
    reply: z.looseObject({ exchanges: z.array(z.unknown()) }),
  })
  .strict();
export const SummaryReply = z
  .object({
    ...stored,
    read: z.literal(SUMMARY_READ),
    reply: z.looseObject({ summary: z.string() }),
  })
  .strict();
export const ReadReply = z.discriminatedUnion("read", [
  MoveReply,
  SummaryReply,
]);
export type ReadReply = z.infer<typeof ReadReply>;
