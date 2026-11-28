import { daysBefore, iso } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { settings } from "../core/settings";
import { readCalendarEvents } from "../sources/google-calendar-events";
import { observationStatusOf, readUnitsOf } from "./memory-files";
import { type DayEvent, scheduledOf } from "./naming-context";
import { kindOf } from "./sources";
import { observationsNow, type People } from "./who";
import { dayStart } from "./zones";

/** Adds `v` to the set of `k` in `m`. */
export const addTo = <K, V>(m: Map<K, Set<V>>, k: K, v: V) =>
  m.set(k, (m.get(k) ?? new Set<V>()).add(v));

/**
 * The timed events of his calendar (`appointmentsCalendar`'s, the one Google calendar Life is given) on each of `dates`,
 * Life's own (`lifeOutput`) left out, each with its guests but him, a room and those who declined (his yes of 22 Nov
 * 2026). Read only; none when it can't be read.
 */
async function readCalendarDay(dates: string[]): Promise<DayEvent[]> {
  const cal = settings().appointmentsCalendar;
  if (!cal) {
    return [];
  }
  try {
    const listed = await Promise.all(
      dates.map((d) =>
        readCalendarEvents(
          cal.calendar,
          cal.account,
          dayStart(d).toISOString(),
          dayStart(daysBefore(d, -1)).toISOString()
        )
      )
    );
    return listed.flat().flatMap((e) =>
      e.start?.dateTime &&
      e.end?.dateTime &&
      e.extendedProperties?.private?.lifeOutput === undefined
        ? [
            {
              at: iso(Date.parse(e.start.dateTime)),
              guests: (e.attendees ?? []).flatMap((a) =>
                a.self || a.resource || a.responseStatus === "declined"
                  ? []
                  : [{ email: a.email, name: a.displayName }]
              ),
              title: e.summary ?? "",
              until: iso(Date.parse(e.end.dateTime)),
            },
          ]
        : []
    );
  } catch (e) {
    log("run.error", { ...errorOf(e), step: "voice-naming.calendar" });
    return [];
  }
}

/**
 * What the voice naming reads of each of `dates`: the people pictured in a photo of it, those in an active fact of it and
 * those in an active plan for it, that no recording is evidence of, and the events of his calendar (`readCalendarDay`).
 */
export async function readNamingDays(dates: string[], people: People) {
  const pictured = new Map<string, Set<string>>();
  for (const u of readUnitsOf(dates).filter((x) => x.source === "photos")) {
    for (const p of u.people.map((x) => people.refOf(x, u.source))) {
      addTo(pictured, u.date, p);
    }
  }
  const facts = new Map<string, Set<string>>();
  const { observations, statusInputs } = await observationsNow(people);
  const active = observations.filter(
    (o) =>
      kindOf(o.source.channel) !== "voice" &&
      observationStatusOf(o, statusInputs).state === "active"
  );
  for (const o of active.filter((x) => dates.includes(x.date))) {
    for (const s of o.subjects) {
      addTo(facts, o.date, s);
    }
  }
  const scheduled = scheduledOf(active, dates, people.truth);
  return { calendar: await readCalendarDay(dates), facts, pictured, scheduled };
}
