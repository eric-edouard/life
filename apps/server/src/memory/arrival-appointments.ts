import { DAY, iso } from "../core/clock";
import { digest } from "../core/hash";
import { isPromptVersion } from "../models/prompt-parts";
import type { Appointment } from "../records/appointment";
import {
  ARRIVAL_APPOINTMENT_READ,
  type ReadReply,
} from "../records/read-reply";
import { READ_REPLIES } from "./memory-files";
import { READS, readRepliesSince } from "./read-replies";

// The appointments agreed in new lines (the arrival reader's `arrival_appointment` read, his word of 21 Nov 2026):
// worked out when read from its stored replies, never stored apart. The calendar sync (`host/appointments-calendar.ts`)
// writes them within minutes; the night's appointments step takes over the id of one its facts cite.

/** How far back the arrival's appointments are read: the sync, his Undo, the event sheet and the night's takeover. */
export const ARRIVAL_APPOINTMENT_DAYS = 30;

/** An appointment agreed in new lines: its id is its messages' hash. */
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

/** The one rule of what is an arrival appointment: an agreed line of the current prompt, the first one per start. */
export function arrivalAppointmentsOf(lines: ReadReply[]) {
  const starts = new Set<string>();
  return lines.flatMap((l): ArrivalAppointment[] => {
    if (
      !(
        l.read === ARRIVAL_APPOINTMENT_READ &&
        l.reply.agreed &&
        isPromptVersion(l.madeBy.prompt, READS.arrival_appointment.prompt)
      ) ||
      starts.has(l.reply.start)
    ) {
      return [];
    }
    starts.add(l.reply.start);
    const { agreed: _, people: __, ...r } = l.reply;
    return [
      {
        ...r,
        at: l.at,
        id: `apt_${digest("sha1", l.messages.join(" "), 12)}`,
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
