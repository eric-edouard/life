import { z } from "zod";
import { isoDate, isoDateTime, MadeBy, slug } from "./fields";

// Memory's matters (memory/matters.jsonl, docs/SCHEMA.md): the running things of his life he never declared, found by
// the matters step from episodes.

/** A matter's id: minted by code, never by a model. */
export const MatterId = z.string().regex(/^matter_[0-9a-f]{12}$/);

/** A record placed in a matter, shown by its own words: one of its steps. */
export const MatterStep = z
  .object({
    /** The day of the record: its episode's day, its observation's, its to-do item's. */
    day: isoDate,
    /** Words of the record's own text that show it belongs, found there by code. */
    quote: z.string().min(1).max(300),
    /** A unit id, an observation id or a to-do item's ledger key. Never an episode id: a day's episodes are rewritten. */
    ref: z.string().min(1),
  })
  .strict();
export type MatterStep = z.infer<typeof MatterStep>;

/** A matter as one call left it: the steps it placed (the union over the file's lines is the matter's). */
export const Matter = z
  .object({
    /** Ids of his areas (truth/areas), possibly none. */
    areas: z.array(slug),
    id: MatterId,
    name: z.string().trim().min(1).max(120),
    /** Ids of his projects (truth/projects). */
    projects: z.array(slug),
    steps: z.array(MatterStep).min(1),
  })
  .strict();
export type Matter = z.infer<typeof Matter>;

/**
 * One call's line of the file: the matters it placed records in, and every record it was asked to place (`offered`):
 * one placed nowhere is so known as asked, and is not asked again.
 */
export const MatterBatch = z
  .object({
    at: isoDateTime,
    madeBy: MadeBy,
    matters: z.array(Matter),
    offered: z.array(z.string().min(1)),
    schemaVersion: z.literal(1),
  })
  .strict();
export type MatterBatch = z.infer<typeof MatterBatch>;

/** A matter's goal in words: one line, where it is going (Life's draft or his word). */
export const GoalText = z.string().trim().min(1).max(200);

/**
 * A matter's goal as Life drafts it: one line, where the matter is going, and whether an agent could move it forward
 * (not a talk only he can have). Pinned to the matter's steps when drafted (oldest first), never to its id: a re-group
 * keeps it (`goalsOf`).
 */
export const MatterGoalDraft = z
  .object({
    agentCanMove: z.boolean(),
    goal: GoalText,
    steps: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type MatterGoalDraft = z.infer<typeof MatterGoalDraft>;

/** One call's line of memory/matter-goals.jsonl: the goals it drafted. */
export const MatterGoalBatch = z
  .object({
    at: isoDateTime,
    goals: z.array(MatterGoalDraft),
    madeBy: MadeBy,
    schemaVersion: z.literal(1),
  })
  .strict();
export type MatterGoalBatch = z.infer<typeof MatterGoalBatch>;

/** A goal as stored, pinned to the steps of its matter: Life's draft (with whether an agent could move it), or his word (`matter-goal`). */
export interface GoalPin {
  agentCanMove?: boolean;
  at: string;
  by: "life" | "owner";
  steps: readonly string[];
  text: string;
}
