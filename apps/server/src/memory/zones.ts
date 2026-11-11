import { statSync } from "node:fs";
import { join } from "node:path";
import { clock, daysBefore, MIN } from "../core/clock";
import { appendJsonl, filesIn, rowsOf } from "../core/files";
import { log } from "../core/log";
import { systemZone } from "../core/platform";
import { isTimeZone } from "../core/time-zone";
import type { Episode } from "../records/episode";
import { Unit, Zone } from "../records/unit";
import { readPhoneZone } from "../sources/lifelog";
import { readSentMailDates } from "../sources/mail";
import { daysOf, UNITS, ZONES } from "./ledger";

// Where the owner was, as a time zone: memory/zones.jsonl, where he was from each `from` on (`readZoneHere`), and the
// wall clock there. Local days and times come from here, never from the zone of the process reading them, so a day read again
// later (in another country) keeps its units' dates and ids. (Schedules, schedule.ts, follow the Mac's own clock.)

let cache = {
  list: [] as { from: number; source?: "mail"; tz: string }[],
  mtime: -1,
};

/**
 * The records by `from` (one about the past, his history told later, is appended after the newer ones), read again
 * when the file changed (the watcher runs for days; a tick may append meanwhile).
 */
function zones() {
  const mtime = statSync(ZONES).mtimeMs;
  if (mtime !== cache.mtime) {
    const list = rowsOf(ZONES, Zone)
      .map((z) => ({ from: Date.parse(z.from), source: z.source, tz: z.tz }))
      .toSorted((a, b) => a.from - b.from);
    cache = { list, mtime };
  }
  return cache.list;
}

const dayOfZone = (z?: { from: number; tz: string }) =>
  z ? wall(new Date(z.from).toISOString(), z.tz).day : "";

/** The local day his first zone record starts: memory can't read a day before it without guessing its zone. */
export const firstZoneDay = () => dayOfZone(zones()[0]);

/**
 * The local day the mail era ends: his first record of where he was, not derived from mail. Before it, sent-mail Date
 * headers may set, defer or gap a day; from it on, a recorded zone covers the day.
 */
const mailEraEnd = () => dayOfZone(zones().find((z) => !z.source));

/** The owner's time zone at `iso`: the latest record from before it (the first one before them all). */
export function zoneAt(iso: string) {
  const list = zones();
  const at = Date.parse(iso);
  return ((list.findLast((z) => z.from <= at) ?? list[0]) as { tz: string }).tz;
}

/**
 * The zone he is in now: the latest move noticed, even one whose `from` is still ahead. `cutAt` keeps the days of what
 * was recorded whole; the present ("today", "in 3 days") follows him at once.
 */
export const zoneNow = () => zones().at(-1)?.tz;

/** His local day now, where he is: for the present only, never to date a recorded line (that is `localDate`). */
export const dayNow = (now = clock()) => wall(now.toISOString(), zoneNow()).day;

const clocks = new Map<string, Intl.DateTimeFormat>();
/** An instant's wall clock in `tz` (by default where he was then): `YYYY-MM-DD` and `HH:MM:SS`. */
export function wall(iso: string, tz = zoneAt(iso)) {
  let format = clocks.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("sv-SE", {
      dateStyle: "short",
      timeStyle: "medium",
      timeZone: tz,
    });
    clocks.set(tz, format);
  }
  const [day = "", hms = ""] = format.format(new Date(iso)).split(" ");
  return { day, hms };
}

/** The instant local `date` starts (or reaches `hm`, "HH:MM") in `tz`, by default where he was then (`cutAt` keeps that one instant). */
export function dayStart(date: string, tz?: string, hm = "00:00") {
  const utc = Date.parse(`${date}T${hm}:00Z`);
  const offset = (at: number) => {
    const iso = new Date(at).toISOString();
    const { day, hms } = wall(iso, tz ?? zoneAt(iso));
    return Date.parse(`${day}T${hms}Z`) - at;
  };
  return new Date(utc - offset(utc - offset(utc)));
}

/**
 * When a move from `was` to `tz` noticed at `now` takes effect: now when both zones are on the same day, else at the
 * next midnight of the one ahead, so a local day never goes back and never starts mid-way. ponytail: that can leave
 * up to a day in the old zone's times.
 */
export function cutAt(now: Date, was: string, tz: string) {
  const [a, b] = [wall(now.toISOString(), was), wall(now.toISOString(), tz)];
  if (a.day === b.day) {
    return now;
  }
  const [ahead, day] = a.day > b.day ? [was, a.day] : [tz, b.day];
  return dayStart(daysBefore(day, -1), ahead);
}

/**
 * Where he is now, his decision (27 Oct): the phone's latest zone, whatever its age. The phone is the source of truth (the
 * recordings go through it, and every upload brings a new one), while the Life server may run anywhere. Undefined when
 * lifelog is set up but can't be read (logged): the last zone recorded, the phone's, stands. The Mac's zone only when no
 * phone ever said one (lifelog not set up, or no heartbeat named a zone).
 */
export async function readZoneHere(
  read = { mac: systemZone, phone: readPhoneZone }
) {
  try {
    return (await read.phone()) ?? read.mac();
  } catch (e) {
    log("source.read", {
      error: (e as Error).message,
      ok: false,
      source: "lifelog",
      what: "zone",
    });
  }
}

/**
 * Records `tz`, where he is now (`readZoneHere`), when it is not the last one recorded: launchd's tick calls it, every
 * 30 minutes, holding the lock. What happened before it was noticed keeps its zone.
 */
export async function noteZone(tz: string | undefined, now = clock()) {
  const was = zoneNow();
  if (tz && was && tz !== was) {
    const from = cutAt(now, was, tz).toISOString();
    await noteZones([{ from, tz }]);
  }
}

/** The local calendar day of an instant: where he was then, whatever zone the Mac is in now. */
export const localDate = (iso: string) => wall(iso).day;

// Spelled out here, not by Intl: ICU versions differ ("Sep" or "Sept"), and Life says a date the same everywhere.
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/** "2026-10-15" -> "15 Oct" and "Thursday". */
export function when(day: string) {
  const d = new Date(`${day}T12:00:00Z`);
  return {
    date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`,
    weekday: new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      weekday: "long",
    }).format(d),
  };
}

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
/** A local day, `YYYY-MM-DD`, not an instant. */
export const isDay = (s: string) => DAY_SHAPE.test(s);
/** A range of days or instants, either end open. */
export interface DayRange {
  from?: string;
  to?: string;
}

/** Days `first` to `last` reach inside `r`. */
const daysMeet = (r: DayRange, first: string, last = first) =>
  (!r.from || last >= r.from.slice(0, 10)) &&
  (!r.to || first <= r.to.slice(0, 10));
/** An episode that has a day inside `r`. */
export const inDays = (r: DayRange) => (m: Episode) =>
  daysMeet(r, ...daysOf(m));

/**
 * `from`..`to` as ISO instants. A date is a local day: `from` starts it, `to` is inclusive (it ends after that day).
 * `from` may be missing; `to` never passes now.
 */
export function dayRange(from?: string, to?: string) {
  const edge = (d: string | undefined, plus: number) => {
    if (!d) {
      return;
    }
    return isDay(d)
      ? dayStart(daysBefore(d, -plus)).toISOString()
      : new Date(d).toISOString();
  };
  const now = clock().toISOString();
  const end = edge(to, 1);
  return { from: edge(from, 0), to: end && end < now ? end : now };
}

/** A line's local day and time, `YYYY-MM-DD HH:MM`, as the episodes and extract prompts show it. */
export const localTime = (iso: string) => `${localDate(iso)} ${time(iso)}`;

export const time = (iso: string) => wall(iso).hms.slice(0, 5);

/** Local days, both included: what a sweep reads. */
export interface Window {
  from: string;
  to: string;
}

/** The last `days` local days, today included. */
export function lastDays(now: Date, days: number): Window {
  const to = localDate(now.toISOString());
  return { from: daysBefore(to, days - 1), to };
}

/** The one writer of past and present zone runs; callers hold the memory lock. */
export function noteZones(
  runs: { from: string; source?: "mail"; tz: string }[],
  path = ZONES
) {
  appendJsonl(
    path,
    Zone,
    runs.map((r) => ({ ...r, schemaVersion: 1 as const }))
  );
}

/** A numeric RFC 5322 Date offset, without rounding a non-hour offset or guessing a city. */
const MAIL_OFFSET = /([+-])(\d{2})(\d{2})(?:\s*\([^)]*\))?\s*$/;
export function parseMailZone(date: string | undefined) {
  const offset = date?.match(MAIL_OFFSET);
  if (offset?.[3] !== "00" || !Number.isFinite(Date.parse(date ?? ""))) {
    return;
  }
  const hours = Number(offset[2]);
  // -0000 means the sender did not know the local offset (RFC 5322).
  if (offset[1] === "-" && hours === 0) {
    return;
  }
  const tz =
    hours === 0 ? "Etc/GMT" : `Etc/GMT${offset[1] === "+" ? "-" : "+"}${hours}`;
  return isTimeZone(tz) ? tz : undefined;
}

/** The Date header's local calendar day, including unsupported fractional-hour offsets. */
function mailDayOf(mail: { at: string; date?: string }) {
  const offset = mail.date?.match(MAIL_OFFSET);
  const instant = Date.parse(mail.date ?? "");
  if (!(offset && Number.isFinite(instant))) {
    return wall(mail.at, "UTC").day;
  }
  const minutes =
    (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === "+" ? 1 : -1);
  return wall(new Date(instant + minutes * MIN).toISOString(), "UTC").day;
}

/** Nearest known sent-mail day, taking the earlier day on a tie. */
function nearestMailDay(day: string, known: { day: string; tz: string }[]) {
  let closest: (typeof known)[number] | undefined;
  for (const candidate of known) {
    if (
      !closest ||
      Math.abs(Date.parse(candidate.day) - Date.parse(day)) <
        Math.abs(Date.parse(closest.day) - Date.parse(day))
    ) {
      closest = candidate;
    }
  }
  return closest;
}

/**
 * Sent-mail days define fixed-offset runs. No-mail days take the nearest known day (ties earlier), and remain gaps in
 * the report. Conflicting, missing and non-hour offsets defer that day. A later model backfill must re-read this report:
 * a nearest-run gap is only a calendar boundary, never evidence of the owner's location.
 */
export function historicalZonesOf(
  sent: { at: string; date?: string }[],
  window: Window
) {
  const byDay = new Map<string, Set<string | undefined>>();
  for (const mail of sent) {
    const tz = parseMailZone(mail.date);
    const day = mailDayOf(mail);
    const offsets = byDay.get(day) ?? new Set<string | undefined>();
    offsets.add(tz);
    byDay.set(day, offsets);
  }
  const known = [...byDay]
    .flatMap(([day, offsets]) => {
      const [tz] = offsets;
      return offsets.size === 1 && tz ? [{ day, tz }] : [];
    })
    .sort((a, b) => a.day.localeCompare(b.day));
  const gaps: string[] = [];
  const deferred: string[] = [];
  const runs: { from: string; tz: string }[] = [];
  let previous: string | undefined;
  for (let day = window.from; day <= window.to; day = daysBefore(day, -1)) {
    const offsets = byDay.get(day);
    if (offsets && (offsets.size !== 1 || offsets.has(undefined))) {
      deferred.push(day);
      continue;
    }
    if (!offsets) {
      gaps.push(day);
    }
    const closest = nearestMailDay(day, known);
    if (!closest) {
      deferred.push(day);
      continue;
    }
    if (closest.tz !== previous) {
      const from = dayStart(day, closest.tz).toISOString();
      if (from <= (runs.at(-1)?.from ?? "")) {
        deferred.push(day);
        continue;
      }
      runs.push({ from, tz: closest.tz });
      previous = closest.tz;
    }
  }
  return { deferred, gaps, runs };
}

/** Re-derive historical uncertainty and eligible runs without writing zones or units. */
export async function readHistoricalZones(
  window: Window,
  read = readSentMailDates
) {
  const files = await filesIn(UNITS);
  const firstUnit = files
    .find((f) => rowsOf(join(UNITS, f), Unit).length > 0)
    ?.slice(0, 10);
  const eraEnd = mailEraEnd();
  const mailDays = {
    from: window.from,
    to: [
      window.to,
      ...(eraEnd ? [daysBefore(eraEnd, 1)] : []),
    ].sort()[0] as string,
  };
  const limit = [
    mailDays.to,
    ...(firstUnit ? [daysBefore(firstUnit, 1)] : []),
  ].sort()[0] as string;
  // Derive gaps again on retries too: appended runs must never turn an unresolved day into known coverage.
  const report = historicalZonesOf(read(new Date(0), clock()), mailDays);
  const deferred = [...report.deferred];
  const stored = new Set(zones().flatMap((z) => (z.source ? [z.from] : [])));
  const runs = report.runs.filter((r) => {
    const { day } = wall(r.from, r.tz);
    return (
      day >= window.from && day <= limit && !stored.has(Date.parse(r.from))
    );
  });
  // Before the first record, zoneAt extrapolates backward. Extending a different final run into stored units would
  // change their dates; restoring it on their first day is forbidden by the past-zone boundary.
  const hasUnsafeExtension =
    firstUnit &&
    runs.length > 0 &&
    rowsOf(join(UNITS, `${firstUnit}.jsonl`), Unit).some(
      (unit) =>
        Date.parse(unit.start) < (zones()[0]?.from ?? 0) &&
        runs.at(-1)?.tz !== zoneAt(unit.start)
    );
  if (hasUnsafeExtension) {
    for (let day = window.from; day <= limit; day = daysBefore(day, -1)) {
      deferred.push(day);
    }
    return {
      ...report,
      deferred: [...new Set(deferred)].sort(),
      reasons: [
        "Historical zones would change the effective zone of stored units; no runs appended.",
      ],
      runs: [] as typeof runs,
    };
  }
  return { ...report, deferred, reasons: [] as string[], runs };
}

/** Append only safe runs before stored units and known coverage; raw headers remain the provenance for gaps. */
export async function prepareHistoricalZones(
  window: Window,
  read = readSentMailDates
) {
  const report = await readHistoricalZones(window, read);
  noteZones(report.runs.map((r) => ({ ...r, source: "mail" as const })));
  return report;
}
