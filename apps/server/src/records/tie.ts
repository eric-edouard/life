import { z } from "zod";
import { isoDateTime } from "./fields";

// A stored tie (memory/ties.jsonl, docs/SCHEMA.md): what someone said two people are to each other, as written.

export const TieId = z.string().regex(/^tie_[0-9a-f]{12}$/);

/**
 * One line of the file, one per quote: `by` said (`OWNER`, or the sender as the source names them) that `of` (a name as
 * written, "Lea") is their `words` ("my partner"), in `quote` on the message `said`, in `unit`, at `at`. Neither side is
 * a ref: who they are is worked out when read (`tiesNow`, `memory/ties.ts`).
 */
export const Tie = z
  .object({
    at: isoDateTime,
    by: z.string().min(1),
    id: TieId,
    of: z.string().min(1),
    quote: z.string().min(1),
    said: z.string().min(1),
    schemaVersion: z.literal(1),
    unit: z.string().min(1),
    words: z.string().min(1),
  })
  .strict();
export type Tie = z.infer<typeof Tie>;

/** `by` says `of` is its `word` (a relation's name, `relationWordOf`). Refs are today's; `quote` is there when someone said it in words (a stored tie). */
export interface TieNow {
  by: string;
  of: string;
  quote?: string;
  word: string;
}
