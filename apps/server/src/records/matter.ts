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
 * What a next step is: `do` (nothing blocks it: it can be done now), `wait_event` (something must arrive: a message, a
 * mail, a delivery, a date), `wait_owner` (something only he does: a call, a visit, a payment by his hand). The fourth
 * kind, `wait_decision` (an open decision he has not answered), is worked out when read (`nextStepNow`), never stored.
 */
export const NextStepKind = z.enum(["do", "wait_event", "wait_owner"]);

/** A matter's next step: one line saying what moves it now, its kind, and for a wait what it waits on. */
export const NextStep = z
  .object({
    kind: NextStepKind,
    text: z.string().trim().min(1).max(200),
    waitsOn: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((n) => n.kind === "do" || n.waitsOn, "a wait says what it waits on");
export type NextStep = z.infer<typeof NextStep>;

/** The parts of a direction as Life drafts it (`MatterDirectionDraft`): the goal, then a next step or the records that show the matter is over. */
export const MatterDirectionFields = z.object({
  /** The ids of the later records a "looks over" draft cites (a few; none when the matter's own steps show it). */
  endingRecords: z.array(z.string().min(1)).max(3).optional(),
  goal: GoalText,
  nextStep: NextStep.optional(),
});

/** Whether a draft says exactly one of: what moves the matter now, or that it looks over. */
export const isNextStepOrOver = (d: {
  endingRecords?: unknown;
  nextStep?: unknown;
}) => (d.nextStep === undefined) !== (d.endingRecords === undefined);
const ONE_OF =
  "a direction gives a next step or the records that show it is over";

/**
 * A matter's direction as Life drafts it: its goal and either its next step or, when the matter looks over, no next
 * step and `endingRecords`. `laterShown`: the ids of the later records the draft was shown (the newest 12), what
 * "checked" is worked out from (`isDirectionDue`); lines before v2 have none. Pinned to the matter's steps when drafted,
 * never to its id: a re-group keeps it (`directionsOf`).
 */
export const MatterDirectionDraft = MatterDirectionFields.extend({
  laterShown: z.array(z.string().min(1)).max(12).optional(),
  steps: z.array(z.string().min(1)).min(1),
})
  .strict()
  .refine(isNextStepOrOver, ONE_OF);
export type MatterDirectionDraft = z.infer<typeof MatterDirectionDraft>;

/** One call's line of memory/matter-directions.jsonl: the directions it drafted. */
export const MatterDirectionBatch = z
  .object({
    at: isoDateTime,
    directions: z.array(MatterDirectionDraft),
    madeBy: MadeBy,
    schemaVersion: z.literal(1),
  })
  .strict();
export type MatterDirectionBatch = z.infer<typeof MatterDirectionBatch>;

/** A direction as stored, pinned to the steps of its matter: Life's draft (a goal, and a next step or the records that show it over), or his word (`matter-direction`: either or both). */
export interface DirectionPin {
  at: string;
  by: "life" | "owner";
  endingRecords?: readonly string[];
  goal?: string;
  laterShown?: readonly string[];
  nextStep?: NextStep;
  steps: readonly string[];
}
