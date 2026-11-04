import { z } from "zod";
import { isoDate, MadeBy, MomentId, UnitId } from "./fields";

// Memory's moments (memory/moments/, docs/SCHEMA.md).

/** `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`, local. */
export const LocalTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/);

/**
 * memory/moments/<day>.jsonl: one thing that happened in the owner's life (a trip, a dinner, a flight), found by the
 * moments step from one day of units across every channel and where his phone stayed. A day's file is rewritten when that day is read again;
 * a moment seen again on a later day keeps its id there; the latest day's line is the moment's current state, and its
 * units are those of all its lines (`momentsNow`).
 */
export const Moment = z
  .object({
    /** The units of the day that are copies of another unit of the moment (two recordings of one stretch of talk). */
    copies: z.array(UnitId),
    /** The day whose units this line was read from. */
    day: isoDate,
    end: LocalTime.nullable(),
    id: MomentId,
    importance: z.int().min(1).max(3),
    madeBy: MadeBy,
    people: z.array(
      z
        .object({
          ref: z.string().regex(/^(person|unknown):/),
          role: z.enum(["with", "told", "organizer"]),
        })
        .strict()
    ),
    place: z.string().min(1).nullable(),
    schemaVersion: z.literal(1),
    start: LocalTime.nullable(),
    title: z.string().min(1).max(200),
    units: z.array(UnitId).min(1),
    /** What happened and what came of it, in one to three sentences. */
    what: z.string().max(600),
    /** The moment holding it (a dinner within a trip), or null. */
    within: MomentId.nullable(),
  })
  .strict();

export type Moment = z.infer<typeof Moment>;
