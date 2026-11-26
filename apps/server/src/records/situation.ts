import { z } from "zod";
import { MadeBy } from "./fields";

// Memory's situations (memory/situations/, memory/project-situations/, memory/matter-situations/: docs/SCHEMA.md).

/**
 * One part of a situation: a paragraph or a list in Markdown, written to him ("you"), resting on what it cites (a
 * person's: episodes, their page or story; a project's or a matter's: the matter steps and records it was shown).
 */
export const SituationPart = z
  .object({
    cites: z.array(z.string().min(1)).min(1),
    markdown: z.string().min(1).max(2000),
  })
  .strict();
export type SituationPart = z.infer<typeof SituationPart>;

/**
 * A situation: where things stand with a person or an organization (`person:<id>`, him included), a project underway
 * (its id) or a matter (its id), the page he sees when opening it. Read nightly from what its step was shown and
 * rewritten whole when its inputs change (`inputs`, their hash), never from its own last version.
 */
export const Situation = z
  .object({
    built: z.string(),
    inputs: z.string(),
    madeBy: MadeBy,
    parts: z.array(SituationPart).min(1),
    schemaVersion: z.literal(2),
    /** Every ref the call was shown (its episodes, steps, records, units, payments, page, story), cited or not: what a deletion reaching any of them hides it for. */
    shown: z.array(z.string()),
    subject: z.string().min(1),
  })
  .strict();
export type Situation = z.infer<typeof Situation>;
