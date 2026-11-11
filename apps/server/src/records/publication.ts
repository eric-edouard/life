import { z } from "zod";
import { SourceName } from "../core/names";
import { isoDateTime } from "./fields";

// Memory's record of what it read (memory/coverage.jsonl, docs/SCHEMA.md).

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** One publication of units: the local days it covers and the sources it read for them. No content. */
export const Published = z
  .object({
    at: isoDateTime,
    from: Day,
    schemaVersion: z.literal(1),
    sources: z.array(SourceName),
    to: Day,
  })
  .strict();
export type Published = z.infer<typeof Published>;
