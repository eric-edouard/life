import { z } from "zod";
import { EpisodeId, isoDate, MadeBy, UnitId } from "./fields";

// Memory's episodes (memory/episodes/, docs/SCHEMA.md).

/** `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`, local. */
export const LocalTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?$/);

/**
 * memory/episodes/<day>.jsonl: one thing that happened in the owner's life (a trip, a dinner, a flight), found by the
 * episodes step from one day of units across every channel and where his phone stayed. A day's file is rewritten when that day is read again;
 * an episode seen again on a later day keeps its id there; the latest day's line is the episode's current state, and its
 * units are those of all its lines (`episodesNow`).
 */
export const Episode = z
  .object({
    /** The units of the day that are copies of another unit of the episode (two recordings of one stretch of talk). */
    copies: z.array(UnitId),
    /** The day whose units this line was read from. */
    day: isoDate,
    end: LocalTime.nullable(),
    id: EpisodeId,
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
    /** The episode holding it (a dinner within a trip), or null. */
    within: EpisodeId.nullable(),
  })
  .strict();

export type Episode = z.infer<typeof Episode>;
