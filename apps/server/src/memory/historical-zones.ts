import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clock, daysBefore, MIN } from "../core/clock";
import { filesIn } from "../core/files";
import { slashed } from "../core/platform";
import { isTimeZone } from "../core/time-zone";
import { UNIT_ID } from "../records/fields";
import type { Zone } from "../records/unit";
import { readSentMailDates } from "../sources/mail";
import { readPhotoOffsets } from "../sources/photos";
import { EPISODES, MEMORY, UNITS } from "./ledger";
import { readySources } from "./sources";
import { unitDays } from "./unit-writer";
import {
  dayStart,
  localDate,
  noteZones,
  type Window,
  wall,
  type ZoneLine,
  zones,
} from "./zones";

// His past zones, before any recorded ones (the derived era: `Zone.source`): each local day's zone is read from what the
// day itself shows, his sent mail's Date headers and the offsets of the photos that place him, one derivation
// (`historicalZonesOf`) over both. Stored zones are corrected only by appended lines (`supersedingRuns`).

/** What one source says of one local day: a zone, or null for an offset no zone here can say (a quarter hour). */
interface DayZone {
  day: string;
  zone: string | null;
}
interface ZoneEvidence {
  mail: DayZone[];
  photos: DayZone[];
}
type Run = Required<Pick<Zone, "source" | "tz">> & { from: string };

/**
 * The zone of a UTC offset in minutes: a whole hour is `Etc/GMT±N` (IANA's sign is reversed); a quarter hour (+5:30,
 * +5:45) is real but unsupported, so null; any other offset (+2:01) is noise, undefined.
 */
export function fixedZoneOf(minutes: number) {
  if (minutes % 15) {
    return;
  }
  if (minutes % 60) {
    return null;
  }
  const hours = minutes / 60;
  const tz =
    hours === 0
      ? "Etc/GMT"
      : `Etc/GMT${hours > 0 ? "-" : "+"}${Math.abs(hours)}`;
  return isTimeZone(tz) ? tz : undefined;
}

const dayAt = (instant: number, minutes: number) =>
  wall(new Date(instant + minutes * MIN).toISOString(), "UTC").day;

/** A numeric RFC 5322 Date offset, kept with its sign: -0000 means the sender did not know the local offset. */
const MAIL_OFFSET = /([+-])(\d{2})(\d{2})(?:\s*\([^)]*\))?\s*$/;

/** The local day and zone of each sent mail; a mail with no whole-hour zone (no usable Date header, -0000, a quarter hour) says nothing. */
export function mailEvidenceOf(sent: { date?: string }[]) {
  return sent.flatMap<DayZone>((mail) => {
    const offset = mail.date?.match(MAIL_OFFSET);
    const instant = Date.parse(mail.date ?? "");
    if (!(offset && Number.isFinite(instant))) {
      return [];
    }
    const minutes =
      (Number(offset[2]) * 60 + Number(offset[3])) *
      (offset[1] === "+" ? 1 : -1);
    const zone =
      offset[1] === "-" && minutes === 0 ? null : fixedZoneOf(minutes);
    return zone ? [{ day: dayAt(instant, minutes), zone }] : [];
  });
}

/** The local day and zone of each photo that places him (`readPhotoOffsets`); a noise offset says nothing. */
export function photoEvidenceOf(photos: { at: string; offset: number }[]) {
  return photos.flatMap<DayZone>((p) => {
    const zone = fixedZoneOf(p.offset);
    return zone === undefined
      ? []
      : [{ day: dayAt(Date.parse(p.at), p.offset), zone }];
  });
}

const byDay = (list: DayZone[]) => {
  const days = new Map<string, Set<string | null>>();
  for (const { day, zone } of list) {
    days.set(day, (days.get(day) ?? new Set()).add(zone));
  }
  return days;
};
/** The one zone a day's evidence agrees on (null for an unsupported offset); undefined when none or when it splits. */
const agreed = (set?: Set<string | null>) =>
  set?.size === 1 ? [...set][0] : undefined;

/**
 * Each day's zone from its own evidence, else the nearest day that has one (ties earlier: a gap).
 * 1. Photos agree on one offset: that zone (`photos`), deferred if it is a quarter hour. A photo is where he stood.
 *    Photos that split are his phone recording a real move: the day is placed by its mail or its neighbours, wrong by
 *    at most the hours in transit.
 * 2. Else mail agrees on one zone: that zone (`mail`). Mail that splits is a gap (a wrong client clock can't be told
 *    from a move), except a travel day, which is deferred.
 * A run carries the source of the day that opened it. `eraFrom` is where the first recorded zone begins: the last day
 * of the era is deferred when it would end after it. Later model backfill must re-read this report: a gap is only a
 * calendar boundary, never evidence of where he was.
 */
export function historicalZonesOf(
  evidence: ZoneEvidence,
  window: Window,
  eraFrom?: string
) {
  const photos = byDay(evidence.photos);
  const mail = byDay(evidence.mail);
  const verdictOf = (day: string) => {
    const photo = agreed(photos.get(day));
    if (photo !== undefined) {
      return photo && { source: "photos" as const, tz: photo };
    }
    const tz = agreed(mail.get(day));
    return tz && { source: "mail" as const, tz };
  };
  const known = [...new Set([...photos.keys(), ...mail.keys()])]
    .sort()
    .flatMap((day) => {
      const verdict = verdictOf(day);
      return verdict ? [{ day, ...verdict }] : [];
    });
  const gaps: string[] = [];
  const deferred: string[] = [];
  const runs: Run[] = [];
  let previous: string | undefined;
  type Known = (typeof known)[number];
  // The days go up, so the first known day after this one only moves forward; the nearest is it or the one before
  // (the earlier on a tie).
  const apart = (a: string, b: string) =>
    Math.abs(Date.parse(a) - Date.parse(b));
  const nearestOf = (day: string, before?: Known, after?: Known) =>
    !after || (before && apart(before.day, day) <= apart(after.day, day))
      ? before
      : after;
  /** A gap day whose own mail names both the zone of the known day before it and of the one after, and they differ. */
  const isTravelDay = (day: string, before?: Known, after?: Known) =>
    before &&
    after &&
    before.tz !== after.tz &&
    mail.get(day)?.has(before.tz) &&
    mail.get(day)?.has(after.tz);
  let next = 0;
  for (let day = window.from; day <= window.to; day = daysBefore(day, -1)) {
    const verdict = verdictOf(day);
    while (next < known.length && (known[next] as Known).day <= day) {
      next += 1;
    }
    const [before, after] = [known[next - 1], known[next]];
    if (verdict === null || (!verdict && isTravelDay(day, before, after))) {
      deferred.push(day);
      continue;
    }
    if (!verdict) {
      gaps.push(day);
    }
    const closest = nearestOf(day, before, after);
    if (
      !closest ||
      (eraFrom &&
        dayStart(daysBefore(day, -1), closest.tz).toISOString() > eraFrom)
    ) {
      deferred.push(day);
      continue;
    }
    if (closest.tz !== previous) {
      const from = dayStart(day, closest.tz).toISOString();
      if (from <= (runs.at(-1)?.from ?? "")) {
        deferred.push(day);
        continue;
      }
      runs.push({ from, source: closest.source, tz: closest.tz });
      previous = closest.tz;
    }
  }
  return { deferred, gaps, runs };
}

/** The evidence of the sources that can be read now: one off or unreadable gives none. */
export function readEvidence(): ZoneEvidence {
  const ready = new Set(readySources().map((s) => s.kind));
  const [since, before] = [new Date(0), clock()];
  return {
    mail: ready.has("mail")
      ? mailEvidenceOf(readSentMailDates(since, before))
      : [],
    photos: ready.has("photos")
      ? photoEvidenceOf(readPhotoOffsets(since, before))
      : [],
  };
}

/** Where the derived era ends: the first recorded zone, one without a `source`, and the day before its local day. */
function derivedEraEnd() {
  const recorded = zones().find((z) => !z.source);
  if (!recorded) {
    return {};
  }
  const from = new Date(recorded.from).toISOString();
  return { from, lastDay: daysBefore(localDate(from), 1) };
}

/** Re-derives the zones of the days of `window` that are in the derived era, without writing anything. */
export function readHistoricalZones(
  window: Window,
  read = readEvidence,
  era = derivedEraEnd()
) {
  const to = [window.to, era.lastDay ?? window.to].sort()[0] as string;
  return historicalZonesOf(read(), { from: window.from, to }, era.from);
}

/** The days among `days` whose units a record outside units/ names by id: what other records now rest on. */
function citedUnitDays(days: string[]) {
  const cited = new Set<string>();
  for (const file of readdirSync(MEMORY, {
    encoding: "utf8",
    recursive: true,
  })) {
    if (file !== "units" && !slashed(file).startsWith("units/")) {
      try {
        for (const id of readFileSync(join(MEMORY, file), "utf8").match(
          UNIT_ID
        ) ?? []) {
          cited.add(id);
        }
      } catch {
        // a folder
      }
    }
  }
  return new Set(
    cited.size === 0
      ? []
      : days.filter((day) =>
          (
            readFileSync(join(UNITS, `${day}.jsonl`), "utf8").match(UNIT_ID) ??
            []
          ).some((id) => cited.has(id))
        )
  );
}

/**
 * The days that keep their stored zone, and so their units and ids, with one neighbour each side: a day a record
 * cites, a day on or after the first episode (the live path's days), and a day the derivation now defers that holds units.
 */
export async function settledDays(
  window: Window,
  deferred: string[],
  holding: ReadonlySet<string>
) {
  const [first] = (await filesIn(EPISODES)).map((f) => f.slice(0, 10));
  const days = unitDays(window);
  const cited = citedUnitDays(days.filter((d) => holding.has(d)));
  const settled = new Set<string>();
  for (const day of days) {
    if (
      cited.has(day) ||
      (first && day >= first) ||
      (holding.has(day) && deferred.includes(day))
    ) {
      for (const d of [daysBefore(day, 1), day, daysBefore(day, -1)]) {
        settled.add(d);
      }
    }
  }
  return settled;
}

/**
 * The lines to append so the stored zones come to equal the derived runs from the first run until `until` (the first
 * recorded zone), one at each instant either list changes where they differ: a later line at the same `from` replaces an
 * earlier one, so no stored line is rewritten or dropped. A settled day keeps its stored zone. Appends nothing when the
 * stored zones already agree.
 */
export function supersedingRuns(
  stored: ZoneLine[],
  derived: Run[],
  settled: ReadonlySet<string>,
  until = Number.POSITIVE_INFINITY
) {
  const runs = derived.map((r) => ({ ...r, at: Date.parse(r.from) }));
  const storedAt = (t: number) => stored.findLast((z) => z.from <= t);
  const storedTz = (t: number) => (storedAt(t) ?? stored[0])?.tz as string;
  const isSettled = (t: number) =>
    settled.has(wall(new Date(t).toISOString(), storedTz(t)).day);
  const edges = [...settled].flatMap((day) => {
    const tz = storedTz(Date.parse(`${day}T12:00:00Z`));
    return [day, daysBefore(day, -1)].map((d) => dayStart(d, tz).getTime());
  });
  const boundaries = [
    ...new Set([
      ...runs.map((r) => r.at),
      ...stored.map((z) => z.from),
      ...edges,
    ]),
  ]
    .filter((t) => t >= (runs[0]?.at ?? until) && t < until)
    .sort((a, b) => a - b);
  const lines: { at: number; source?: Run["source"]; tz: string }[] = [];
  for (const t of boundaries) {
    const run = runs.findLast((r) => r.at <= t) as (typeof runs)[number];
    const want = isSettled(t) ? (storedAt(t) ?? stored[0] ?? run) : run;
    const last = lines.at(-1);
    const was =
      last && last.at >= (storedAt(t)?.from ?? Number.NEGATIVE_INFINITY)
        ? last.tz
        : storedTz(t);
    if (was !== want.tz) {
      lines.push({ at: t, source: want.source, tz: want.tz });
    }
  }
  return lines.map((l) => ({
    from: new Date(l.at).toISOString(),
    source: l.source,
    tz: l.tz,
  }));
}

/**
 * Appends the lines that make the stored zones follow the derivation, only when `window` covers the whole derived era
 * (from the first stored unit day or earlier, to the era's last day): a narrower one appends nothing, so no edge ever
 * moves hours into a day the collection does not re-cut.
 */
export async function prepareHistoricalZones(
  window: Window,
  read = readEvidence
) {
  const era = derivedEraEnd();
  const report = readHistoricalZones(window, read, era);
  const files = (await filesIn(UNITS)).map((f) => f.slice(0, 10));
  if (
    window.to >= (era.lastDay ?? window.to) &&
    window.from <= (files[0] ?? window.from)
  ) {
    const to = era.lastDay ?? window.to;
    noteZones(
      supersedingRuns(
        zones(),
        report.runs,
        await settledDays(
          { from: window.from, to },
          report.deferred,
          new Set(files)
        ),
        era.from ? Date.parse(era.from) : undefined
      )
    );
  }
  return report;
}
