import { DAY, iso } from "../core/clock";
import { digest } from "../core/hash";
import { isPromptVersion } from "../models/prompt-parts";
import type { Appointment } from "../records/appointment";
import {
  ARRIVAL_APPOINTMENT_READ,
  type ReadReply,
} from "../records/read-reply";
import { span } from "./episode-span";
import { READ_REPLIES } from "./memory-files";
import { READS, readRepliesSince } from "./read-replies";
import { dayStart } from "./zones";

// The appointments agreed in new lines (the arrival reader's `arrival_appointment` read, his word of 21 Nov 2026):
// worked out when read from its stored replies, never stored apart. The calendar sync (`host/appointments-calendar.ts`)
// writes them within minutes; the night's appointments step takes over the id of one its facts cite.

/** How far back the arrival's appointments are read: the sync, his Undo, the event sheet and the night's takeover. */
export const ARRIVAL_APPOINTMENT_DAYS = 30;

/** An appointment agreed in new lines: its id is its meeting key's hash, the same whichever lines agreed it. */
export type ArrivalAppointment = Omit<
  Appointment,
  "observations" | "timeGuessed"
> & {
  /** When the read was made. */
  at: string;
  /** A meeting link copied exactly from the lines (https). */
  link: string | null;
  /** The keys of the messages it was read from, oldest first. */
  messages: string[];
  quote: string;
  unit: string;
};

export type Meeting = Pick<Appointment, "allDay" | "end" | "start" | "zone">;

/** When a meeting starts: an instant (in its zone, else where he is then), or its first day when it is all-day. */
export const meetingStartOf = (a: Meeting) =>
  span(
    { day: a.start.slice(0, 10), end: a.end, start: a.start },
    a.zone ?? undefined
  ).from;

/** A whole day's start where it is: its zone's midnight (two names of one zone are one). */
const dayAtOf = (a: Meeting) =>
  dayStart(a.start.slice(0, 10), a.zone ?? undefined).toISOString();

/**
 * One meeting's key, for its id: when its zone is named, its start instant, or its day's midnight there when whole (two
 * names of one zone are one meeting; two calls at 10:00, or two days, in two zones are two); else its local start,
 * which no move of his changes.
 */
export const meetingKeyOf = (a: Meeting) => {
  if (!a.zone) {
    return `${a.start} `;
  }
  return a.allDay ? `day ${dayAtOf(a)}` : meetingStartOf(a);
};

/**
 * Whether two readings are one meeting, the one rule of the sync's join and the night's takeover: one start instant
 * when timed; one day when whole, and one midnight when both name a zone (a reading without a zone is where he is).
 */
export const isSameMeeting = (a: Meeting, b: Meeting) => {
  if (a.allDay !== b.allDay) {
    return false;
  }
  if (!a.allDay) {
    return meetingStartOf(a) === meetingStartOf(b);
  }
  return (
    a.start === b.start && (!(a.zone && b.zone) || dayAtOf(a) === dayAtOf(b))
  );
};

/** The one rule of what is an arrival appointment: an agreed line of the current prompt, the first one per meeting (`meetingKeyOf`: one meeting, one id). */
export function arrivalAppointmentsOf(lines: ReadReply[]) {
  const keys = new Set<string>();
  return lines.flatMap((l): ArrivalAppointment[] => {
    if (
      !(
        l.read === ARRIVAL_APPOINTMENT_READ &&
        l.reply.agreed &&
        isPromptVersion(l.madeBy.prompt, READS.arrival_appointment.prompt)
      ) ||
      keys.has(meetingKeyOf(l.reply))
    ) {
      return [];
    }
    keys.add(meetingKeyOf(l.reply));
    const { agreed: _, people: __, ...r } = l.reply;
    return [
      {
        ...r,
        at: l.at,
        id: `apt_${digest("sha1", `arrival ${meetingKeyOf(l.reply)}`, 12)}`,
        messages: l.messages,
        unit: l.unit,
      },
    ];
  });
}

/** The arrival appointments read in the last `ARRIVAL_APPOINTMENT_DAYS` (a read is filed by its first line's month, at most two days before it). */
export function readArrivalAppointments(now: Date, where = READ_REPLIES) {
  const since = iso(now.getTime() - ARRIVAL_APPOINTMENT_DAYS * DAY);
  return arrivalAppointmentsOf(
    readRepliesSince(iso(Date.parse(since) - 2 * DAY), where).filter(
      (l) => l.at >= since
    )
  );
}
