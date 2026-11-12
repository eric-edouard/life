import { z } from "zod";
import { clock, daysBefore } from "../core/clock";
import { readJson, writeJson } from "../core/files";
import { log } from "../core/log";
import { isoDateTime } from "../records/fields";
import { lifelogMissing } from "../sources/lifelog";
import { type Recorded, readRecorded } from "../sources/lifelog-recorded";
import { RECORDED_DAYS } from "./ledger";
import { localDate } from "./zones";

// The recorded days (docs/glossary.md): the local days the pendant recorded on, with or without speech, as lifelog
// says (`GET /recorded`), kept in Life's state (`RECORDED_DAYS`, never his data) so no read asks lifelog: coverage's
// evidence for a pendant day Life holds nothing of. lifelog is the truth: the night asks for all of it and rewrites
// the file whole, so late audio and a changed zone are never stale past a night.

const Stored = z
  .object({
    /** When lifelog was asked. */
    built: isoDateTime,
    days: z.array(z.string()),
    /** Since when lifelog can tell; null when it holds no recording. */
    since: isoDateTime.nullable(),
  })
  .strict();
export type RecordedDays = z.infer<typeof Stored>;

/** The local days the stretches touch, sorted: one over midnight gives both days. */
export function recordedDaysOf(stretches: Recorded["stretches"]) {
  const days = new Set<string>();
  for (const s of stretches) {
    const last = localDate(s.endAt);
    for (
      let day = localDate(s.startAt);
      day <= last;
      day = daysBefore(day, -1)
    ) {
      days.add(day);
    }
  }
  return [...days].sort();
}

/**
 * Asks lifelog for every stretch it holds and rewrites the file whole. Without lifelog nothing is written; when it
 * does not answer, it is logged, `failed` says so and the last file stands.
 * ponytail: all of lifelog's history is asked each night (a third of a second a month of it); keep the closed months
 * if that ever costs.
 */
export async function writeRecordedDays() {
  if (lifelogMissing()) {
    return { days: 0, failed: 0 };
  }
  try {
    const built = clock().toISOString();
    const { since, stretches } = await readRecorded(built);
    const days = recordedDaysOf(stretches);
    writeJson(RECORDED_DAYS, Stored.parse({ built, days, since }));
    return { days: days.length, failed: 0 };
  } catch (e) {
    log("run.error", {
      error: (e as Error).message,
      step: "memory.recorded-days",
    });
    return { days: 0, failed: 1 };
  }
}

/** The recorded days, or null when lifelog was never asked (no file, or one in another shape). */
export const readRecordedDays = () =>
  Stored.safeParse(readJson(RECORDED_DAYS)).data ?? null;
