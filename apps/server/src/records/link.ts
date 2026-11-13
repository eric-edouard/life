import { z } from "zod";
import { isoDateTime, MadeBy, SubjectRef } from "./fields";
import { ObservationId } from "./observation";

// Memory's links (memory/links.jsonl, docs/SCHEMA.md): two observations tied, found by the links step.

/** Two observations tied: `later` ends `earlier` (the one relation read so far), shown by `later`'s own words. */
export const Link = z
  .object({
    earlier: ObservationId,
    later: ObservationId,
    /** Words of the later observation's quote that show it, found there by code. */
    quote: z.string().min(1).max(300),
    relation: z.literal("ends"),
  })
  .strict();
export type Link = z.infer<typeof Link>;

/**
 * One judged batch, a line of the file: for `subject`, the open things shown (`open`) and the later observations
 * offered against them (`offered`), and the links kept. A pair in it is never judged again, link or not.
 */
export const LinkBatch = z
  .object({
    at: isoDateTime,
    links: z.array(Link),
    madeBy: MadeBy,
    offered: z.array(ObservationId),
    open: z.array(ObservationId),
    schemaVersion: z.literal(1),
    subject: SubjectRef,
  })
  .strict();
export type LinkBatch = z.infer<typeof LinkBatch>;
