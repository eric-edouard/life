import { statSync } from "node:fs";
import { clock, daysBefore } from "../core/clock";
import { appendJsonl, rowsOf } from "../core/files";
import { log } from "../core/log";
import { systemZone } from "../core/platform";
import type { Episode } from "../records/episode";
import { Zone } from "../records/unit";
import { readPhoneZone } from "../sources/lifelog";
import { daysOf, ZONES } from "./memory-files";

// Where the owner was, as a time zone: memory/zones.jsonl, where he was from each `from` on (`readZoneHere`), and the
// wall clock there. Local days and times come from here, never from the zone of the process reading them, so a day read again
// later (in another country) keeps its units' dates and ids. (Schedules, schedule.ts, follow the Mac's own clock.)

export interface ZoneLine {
  from: number;
  source?: Zone["source"];
  tz: string;
}

let cache = { list: [] as ZoneLine[], mtime: -1 };

/**
 * The records by `from` (a later line at the same `from` replaces an earlier one: the sort is stable), read again
 * when the file changed (the watcher runs for days; a tick may append meanwhile).
 */
export function zones() {
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

/** `tz`'s offset from UTC at `iso`, in ms (by default where he was then). */
export function offsetAt(iso: string, tz = zoneAt(iso)) {
  const { day, hms } = wall(iso, tz);
  return (
    Date.parse(`${day}T${hms}Z`) - Math.floor(Date.parse(iso) / 1000) * 1000
  );
}

/** The instant local `date` starts (or reaches `hm`, "HH:MM") in `tz`, by default where he was then (`cutAt` keeps that one instant). */
export function dayStart(date: string, tz?: string, hm = "00:00") {
  const utc = Date.parse(`${date}T${hm}:00Z`);
  const offset = (at: number) => offsetAt(new Date(at).toISOString(), tz);
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

/** Local days, both included: what a processing run reads. */
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
  runs: { from: string; source?: Zone["source"]; tz: string }[],
  path = ZONES
) {
  appendJsonl(
    path,
    Zone,
    runs.map((r) => ({ ...r, schemaVersion: 1 as const }))
  );
}

/** The calendar months of a window of local days, each bounded by the window's own first and last day. */
export function monthsOf(window: Window) {
  const months: Window[] = [];
  let { from } = window;
  while (from <= window.to) {
    const year = Number(from.slice(0, 4));
    const month = Number(from.slice(5, 7));
    const next = `${year + Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, "0")}-01`;
    const to = [daysBefore(next, 1), window.to].sort()[0] as string;
    months.push({ from, to });
    from = daysBefore(to, -1);
  }
  return months;
}
