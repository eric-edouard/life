import { statSync } from "node:fs";
import { clock, DAY } from "../core/clock";
import { appendJsonl, rowsOf } from "../core/files";
import { systemZone } from "../core/platform";
import { Zone } from "../records/unit";
import { ZONES } from "./ledger";

// Where the owner was, as a time zone: memory/zones.jsonl, the Mac's zone from each `from` on, and the wall clock
// there. Local days and times come from here, never from the zone of the process reading them, so a day read again
// later (in another country) keeps its units' dates and ids. (Schedules, schedule.ts, follow the Mac's own clock.)

let cache = { list: [] as { from: number; tz: string }[], mtime: -1 };

/**
 * The records by `from` (one about the past, his history told later, is appended after the newer ones), read again
 * when the file changed (the watcher runs for days; a tick may append meanwhile).
 */
function zones() {
  const mtime = statSync(ZONES).mtimeMs;
  if (mtime !== cache.mtime) {
    const list = rowsOf(ZONES, Zone)
      .map((z) => ({ from: Date.parse(z.from), tz: z.tz }))
      .toSorted((a, b) => a.from - b.from);
    cache = { list, mtime };
  }
  return cache.list;
}

/** The local day his first zone record starts: memory can't read a day before it without guessing its zone. */
export const firstZoneDay = () => {
  const [first] = zones();
  return first ? wall(new Date(first.from).toISOString(), first.tz).day : "";
};

/** The owner's time zone at `iso`: the latest record from before it (the first one before them all). */
export function zoneAt(iso: string) {
  const list = zones();
  const at = Date.parse(iso);
  return ((list.findLast((z) => z.from <= at) ?? list[0]) as { tz: string }).tz;
}

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
  const next = new Date(Date.parse(`${day}T12:00:00Z`) + DAY);
  return dayStart(next.toISOString().slice(0, 10), ahead);
}

/**
 * Records the Mac's zone (the system's, whatever TZ the process runs with) when it is not the last one recorded:
 * launchd's tick calls it, every 30 minutes, holding the lock. What happened before it was noticed keeps its zone.
 * ponytail: the Mac travels with him; the Mac mini (roadmap 4.7) stays home, so its zone will need another source then
 * (his phone's, or the voice server's stays).
 */
export async function noteZone(now = clock()) {
  const tz = systemZone();
  const was = zones().at(-1)?.tz;
  if (tz && was && tz !== was) {
    const from = cutAt(now, was, tz).toISOString();
    await appendJsonl(ZONES, Zone, [{ from, schemaVersion: 1, tz }]);
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
