import { z } from "zod";
import { FoundQuote, isoDate, isoDateTime, MadeBy } from "./fields";

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

/** One sentence of a month's full text, with the local days it rests on. */
const HistorySentence = z
  .object({
    days: z.array(isoDate).min(1),
    text: z.string().min(1).max(600),
  })
  .strict();
export type HistorySentence = z.infer<typeof HistorySentence>;

const monthOf = {
  built: isoDateTime,
  inputs: z.string(),
  madeBy: MadeBy,
  month: z.string().regex(/^\d{4}-\d{2}$/),
};

/** The sentences of a month together, in characters at most. */
export const FULL_TEXT_CHARS = 4500;

/**
 * One closed month, kept under what was shown (`inputs`), in one of two shapes, never both: in two sizes (read by
 * `memory-history-month.v2` from all the person's evidence of the month: a headline and the full text as sentences, each
 * with its days), or as parts (read before, from one-to-one chats and mail only: a part per call that read it).
 * ponytail: the parts arm goes once a full rebuild has read every month again and a migration with his OK drops the rest.
 */
export const HistoryMonth = z.union([
  z
    .object({
      ...monthOf,
      headline: z.string().min(1).max(300),
      sentences: z.array(HistorySentence).min(1).max(60),
    })
    .strict()
    .refine(
      (m) =>
        m.sentences.reduce((n, s) => n + s.text.length, 0) <= FULL_TEXT_CHARS
    ),
  z.object({ ...monthOf, parts: z.array(HistoryPart).min(1) }).strict(),
]);
export type HistoryMonth = z.infer<typeof HistoryMonth>;

/** A month's full text, derived and never stored: its sentences joined, or for a month read in parts its summaries. */
export const fullTextOf = (m: HistoryMonth) =>
  "sentences" in m
    ? m.sentences.map((s) => s.text).join(" ")
    : m.parts.map((p) => p.summary).join(" ");

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
