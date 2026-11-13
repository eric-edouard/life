import { z } from "zod";
import { SourceName } from "../core/names";
import { EntityRef, EpisodeId, isoDate, isoDateTime, UnitId } from "./fields";
import { ObservationId } from "./observation";

// The statements the owner rates, their ratings and the eval's scores (docs/SCHEMA.md).

/** memory/statements.jsonl: the fact checks, one statement per claim, frozen as he was shown it (docs/SCHEMA.md). */
export const FactCheck = z
  .object({
    at: isoDateTime,
    date: isoDate,
    group: z.union([EntityRef, z.literal("episodes")]),
    kind: z.enum(["fact", "plan", "reported", "episode"]),
    ref: z.union([ObservationId, EpisodeId]),
    schemaVersion: z.literal(1),
    source: SourceName.nullable(),
    text: z.string().min(1),
    units: z.array(UnitId).min(1),
  })
  .strict();

export type FactCheck = z.infer<typeof FactCheck>;

/** memory/ratings.jsonl: his answers to the fact checks, the latest per claim counting; null is an undo (docs/SCHEMA.md). */
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

/** memory/scores.jsonl: one line per scored run (`bun scripts/eval.ts --ratings`), its counts (docs/SCHEMA.md). */
export const EvalScore = z
  .object({
    at: isoDateTime,
    // Kept both (stated and contradicted), counted apart since 28 Oct 2026; older lines counted it in contradicted or restated.
    both: z.int().min(0).default(0),
    contradicted: z.int().min(0),
    gone: z.int().min(0),
    held: z.int().min(0),
    missed: z.int().min(0),
    outdated: z.int().min(0).default(0),
    rated: z.int().min(0),
    restated: z.int().min(0),
    run: z.string(),
    schemaVersion: z.literal(1),
    trues: z.int().min(0),
    ungraded: z.int().min(0),
  })
  .strict();
