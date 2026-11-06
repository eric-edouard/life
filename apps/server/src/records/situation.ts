import { z } from "zod";
import { EpisodeId, MadeBy } from "./fields";

// Memory's situations (memory/situations/, docs/SCHEMA.md).

/** One line of a situation: where things stand, resting on the episodes it cites. */
export const SituationLine = z
  .object({
    cites: z.array(EpisodeId).min(1),
    text: z.string().min(1).max(400),
  })
  .strict();
export type SituationLine = z.infer<typeof SituationLine>;

/**
 * memory/situations/<id>.json: where things stand now with the owner (`me`) or someone close to him, read nightly from
 * the last days' episodes and the page; rewritten whole when its inputs change (`inputs`, their hash), never from its
 * own last version.
 */
export const Situation = z
  .object({
    built: z.string(),
    inputs: z.string(),
    lines: z.array(SituationLine),
    madeBy: MadeBy,
    page: z.string().regex(/^person:/),
    schemaVersion: z.literal(1),
  })
  .strict();
export type Situation = z.infer<typeof Situation>;
