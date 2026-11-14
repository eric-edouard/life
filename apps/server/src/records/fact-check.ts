import { z } from "zod";
import { SourceName } from "../core/names";
import { EpisodeId, isoDate, isoDateTime, SubjectRef, UnitId } from "./fields";
import { ObservationId } from "./observation";

// The fact checks, the owner's answers to them and the eval's scores (docs/SCHEMA.md).

/** memory/fact-checks.jsonl: the fact checks, one per memory line, as he was shown it, its text and source (not the later step's words), written with his answer (docs/SCHEMA.md). */
export const FactCheck = z
  .object({
    at: isoDateTime,
    date: isoDate,
    /** An ending check (from 14 Nov 2026): the step a link says ended `ref`; `text` is the check's guess, "Life thinks this is done: …" (earlier lines hold "Done? …"). Absent for a doubt. */
    endedBy: z.union([ObservationId, EpisodeId]).optional(),
    group: z.union([SubjectRef, z.literal("episodes")]),
    kind: z.enum(["fact", "plan", "reported", "episode"]),
    ref: z.union([ObservationId, EpisodeId]),
    schemaVersion: z.literal(1),
    source: SourceName.nullable(),
    text: z.string().min(1),
    units: z.array(UnitId).min(1),
  })
  .strict();

export type FactCheck = z.infer<typeof FactCheck>;

/** Whether a fact check asks if an open step ended (it names `endedBy`); every other one is a doubt. */
export const isEndingCheck = (s: { endedBy?: string }) =>
  s.endedBy !== undefined;

/** memory/fact-check-answers.jsonl: his answers to the fact checks, the latest per memory line counting; null is an undo (docs/SCHEMA.md). */
export const FactCheckAnswer = z
  .object({
    answer: z.enum(["true", "false", "partly", "outdated", "skip"]).nullable(),
    at: isoDateTime,
    /** His why, in his words (from 29 Oct 2026). */
    note: z.string().min(1).optional(),
    ref: z.union([ObservationId, EpisodeId]),
    schemaVersion: z.literal(1),
  })
  .strict();

export type FactCheckAnswer = z.infer<typeof FactCheckAnswer>;

/** memory/scores.jsonl: one line per scored run (`bun scripts/eval.ts --fact-check-answers`), its counts (docs/SCHEMA.md). */
export const EvalScore = z
  .object({
    answered: z.int().min(0),
    at: isoDateTime,
    // Kept both (stated and contradicted), counted apart since 28 Oct 2026; older lines counted it in contradicted or restated.
    both: z.int().min(0).default(0),
    contradicted: z.int().min(0),
    gone: z.int().min(0),
    held: z.int().min(0),
    missed: z.int().min(0),
    outdated: z.int().min(0).default(0),
    restated: z.int().min(0),
    run: z.string(),
    schemaVersion: z.literal(1),
    trues: z.int().min(0),
    ungraded: z.int().min(0),
  })
  .strict();
