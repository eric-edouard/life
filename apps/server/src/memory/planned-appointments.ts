import type { Appointment } from "../records/appointment";
import { type ArrivalAppointment, isSameMeeting } from "./arrival-appointments";
import { span } from "./episode-span";
import { dayStart } from "./zones";

// One draft per meeting, from the night's appointments and the arrival's: what the calendar sync writes and what the
// event sheet shows (`read-appointments.ts`), one rule for both.

/** What the sync writes: one of the night's appointments (with `agreed` when he agreed it in new lines), or one agreed in new lines. */
export type Planned =
  | (Appointment & {
      agreed?: { link: string | null; unit?: string };
      arrival?: ArrivalAppointment;
    })
  | ArrivalAppointment;
export const isArrival = (a: Planned): a is ArrivalAppointment =>
  "messages" in a;
/** Whether an appointment's event ends after `now` (its own instant, in its zone). */
export const isAhead = (a: Planned, now: Date) => {
  const { allDay, to } = span(
    { day: a.start.slice(0, 10), end: a.end, start: a.start },
    a.zone ?? undefined
  );
  // A whole day ends at midnight where it is.
  const end = allDay ? dayStart(to, a.zone ?? undefined) : new Date(to);
  return end.getTime() > now.getTime();
};

/**
 * One draft per meeting: a night's appointment and an arrival of the same id or meeting (`isSameMeeting`) are one, with the night's
 * details, his agreement and its link, under the id that already has event lines (`hasEvent`), else the arrival's;
 * a night's appointment whose event says he agreed it (`agreedOn`) stays agreed; an arrival already over is left out.
 */
export function plannedOf(
  night: readonly Appointment[],
  arrivals: readonly ArrivalAppointment[],
  agreedOn: ReadonlyMap<string, { link: string | null; unit?: string }>,
  hasEvent: (id: string) => boolean,
  now: Date
): Planned[] {
  const ahead = arrivals.filter((a) => isAhead(a, now));
  // One to one: an arrival joins one night's appointment at most, its own id's first, then one of its start.
  const joined = new Set(
    night.flatMap((n) => (ahead.some((x) => x.id === n.id) ? [n.id] : []))
  );
  const nights = night.map((n) => {
    const a =
      ahead.find((x) => x.id === n.id) ??
      ahead.find((x) => isSameMeeting(x, n) && !joined.has(x.id));
    if (!a) {
      const agreed = agreedOn.get(n.id);
      return agreed ? { ...n, agreed } : n;
    }
    joined.add(a.id);
    return {
      ...n,
      agreed: { link: a.link, unit: a.unit },
      // The arrival it joined, for its sheet (`read-appointments.ts`); never part of its event.
      arrival: a,
      id: hasEvent(n.id) ? n.id : a.id,
    };
  });
  return [...nights, ...ahead.filter((a) => !joined.has(a.id))];
}
