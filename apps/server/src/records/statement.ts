import { z } from "zod";
import { SourceName } from "../core/names";
import { EntityRef, isoDate, isoDateTime, MomentId, UnitId } from "./fields";
import { ObservationId } from "./observation";

// The statements the owner rates, their ratings and the eval's scores (docs/SCHEMA.md).

/** memory/statements.jsonl: the truth benchmark, one statement per claim, frozen as he was shown it (docs/SCHEMA.md). */
export const Statement = z
  .object({
    at: isoDateTime,
    date: isoDate,
    group: z.union([EntityRef, z.literal("events")]),
    kind: z.enum(["fact", "plan", "reported", "moment"]),
    ref: z.union([ObservationId, MomentId]),
    schemaVersion: z.literal(1),
    source: SourceName.nullable(),
    text: z.string().min(1),
    units: z.array(UnitId).min(1),
  })
  .strict();

export type Statement = z.infer<typeof Statement>;

/** memory/ratings.jsonl: his answers on the check page, the latest per claim counting; null is an undo (docs/SCHEMA.md). */
export const Rating = z
  .object({
    answer: z.enum(["true", "false", "outdated", "skip"]).nullable(),
    at: isoDateTime,
    ref: z.union([ObservationId, MomentId]),
    schemaVersion: z.literal(1),
  })
  .strict();

export type Rating = z.infer<typeof Rating>;

/** memory/scores.jsonl: one line per scored run (`bun scripts/eval.ts --ratings`), its counts (docs/SCHEMA.md). */
export const EvalScore = z
  .object({
    at: isoDateTime,
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
