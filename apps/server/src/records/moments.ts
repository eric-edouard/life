import { z } from "zod";
import { isoDate, MomentId, UnitId } from "./fields";
import { MadeBy } from "./ledger";

// Memory's moments (memory/moments/, docs/SCHEMA.md).
/** How a claim was said: as true, as settled for later, about a third person, or only conditionally (a hypothesis, a quote). */
export const Modality = z.enum(["fact", "plan", "reported", "conditional"]);
/** `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`, local. */
export const LocalTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/);
/**
 * memory/moments/<day>.jsonl: one thing that happened or is planned in the owner's life (a trip, a dinner, a flight), found by
 * the moments step from one day of units across every channel. A day's file is rewritten when that day is read again;
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
    status: z.enum(["happened", "planned", "cancelled", "unsure"]),
    title: z.string().min(1).max(200),
    units: z.array(UnitId).min(1),
    why: z.string().max(300),
  })
  .strict();
export type Moment = z.infer<typeof Moment>;
