import { z } from "zod";
import { EpisodeId, MadeBy } from "./fields";

// Memory's situations (memory/situations/, docs/SCHEMA.md).

/** One line of a situation: where things stand, resting on what it cites (a person's: episodes; a project's: matter steps). */
const lineOf = <C extends z.ZodType<string>>(cite: C) =>
  z
    .object({
      cites: z.array(cite).min(1),
      text: z.string().min(1).max(400),
    })
    .strict();
export const SituationLine = lineOf(EpisodeId);
export type SituationLine = z.infer<typeof SituationLine>;
export const ProjectSituationLine = lineOf(z.string().min(1));
export type ProjectSituationLine = z.infer<typeof ProjectSituationLine>;

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

/**
 * memory/project-situations/<project>.json: where a project underway stands now, read nightly from its directory entry and
 * its matters as they read now (`memory/project-situations.ts`); each line cites the matter steps it rests on. Rewritten
 * whole when its inputs change (`inputs`, their hash), never from its own last version.
 */
export const ProjectSituation = z
  .object({
    built: z.string(),
    inputs: z.string(),
    lines: z.array(ProjectSituationLine),
    madeBy: MadeBy,
    project: z.string().min(1),
    schemaVersion: z.literal(1),
  })
  .strict();
export type ProjectSituation = z.infer<typeof ProjectSituation>;
