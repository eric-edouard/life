import { z } from "zod";
import { EpisodeId, isoDateTime, MadeBy, SubjectRef } from "./fields";
import { MatterId } from "./matter";
import { ObservationId } from "./observation";

// Memory's links (memory/links.jsonl, docs/SCHEMA.md): two records tied, found by the links step.

/** Two records tied: the step `later` (an observation or an episode) ends the observation `earlier` (the one relation read so far), shown by `later`'s own words. */
export const Link = z
  .object({
    earlier: ObservationId,
    later: z.union([ObservationId, EpisodeId]),
    /** Words of the later step's quote that show it, found there by code. */
    quote: z.string().min(1).max(300),
    relation: z.literal("ends"),
  })
  .strict();
export type Link = z.infer<typeof Link>;

/**
 * One judged batch, a line of the file: for `subject` (a matter's id; a person in the first lines), the open observations shown (`open`) and the
 * later steps offered against them (`offered`), and the links kept. A pair in it is never judged again, link or not.
 */
export const LinkBatch = z
  .object({
    at: isoDateTime,
    links: z.array(Link),
    madeBy: MadeBy,
    offered: z.array(ObservationId),
    open: z.array(ObservationId),
    schemaVersion: z.literal(1),
    subject: z.union([MatterId, SubjectRef]),
  })
  .strict();
export type LinkBatch = z.infer<typeof LinkBatch>;
