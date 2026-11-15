import { z } from "zod";
import { FoundQuote, isoDateTime, MadeBy } from "./fields";

// Memory's histories (memory/histories/, docs/SCHEMA.md): a person's past months with him, summarised once.

const HistoryQuote = FoundQuote.extend({
  writer: z.enum(["owner", "them"]),
}).strict();

/** What one call read of a month: its summary, and the quotes found in the messages it was shown (none when nothing was long enough to quote). */
export const HistoryPart = z
  .object({
    quotes: z.array(HistoryQuote).max(4),
    summary: z.string().min(1).max(1500),
  })
  .strict();
export type HistoryPart = z.infer<typeof HistoryPart>;

/** One closed month: a part per call that read it (a large month is read in several), kept under what was shown (`inputs`). */
const HistoryMonth = z
  .object({
    built: isoDateTime,
    inputs: z.string(),
    madeBy: MadeBy,
    month: z.string().regex(/^\d{4}-\d{2}$/),
    parts: z.array(HistoryPart).min(1),
  })
  .strict();
export type HistoryMonth = z.infer<typeof HistoryMonth>;

/** The months through a closed year told as one story, kept under those months (`inputs`). */
const HistoryStory = z
  .object({
    built: isoDateTime,
    inputs: z.string(),
    madeBy: MadeBy,
    text: z.string().min(1).max(6000),
    through: z.string().regex(/^\d{4}$/),
  })
  .strict();

export const History = z
  .object({
    months: z.array(HistoryMonth),
    schemaVersion: z.literal(1),
    story: HistoryStory.nullable(),
  })
  .strict();
export type History = z.infer<typeof History>;
