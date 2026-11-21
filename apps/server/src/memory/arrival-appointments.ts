import { z } from "zod";
import { DAY, HOUR, iso } from "../core/clock";
import { digest } from "../core/hash";
import { isPromptVersion } from "../models/prompt-parts";
import type { Appointment } from "../records/appointment";
import {
  ARRIVAL_APPOINTMENT_READ,
  ArrivalAppointmentReply,
  type ReadReply,
} from "../records/read-reply";
import { span } from "./episode-span";
import { READ_REPLIES } from "./memory-files";
import { locate } from "./quote-check";
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
export function readArrivalAppointments(
  now: Date,
  where = READ_REPLIES,
  /** Read back to here instead when it is earlier: the sheet of an event written before the window. */
  from?: string
) {
  const window = iso(now.getTime() - ARRIVAL_APPOINTMENT_DAYS * DAY);
  const since = from && from < window ? from : window;
  return arrivalAppointmentsOf(
    readRepliesSince(iso(Date.parse(since) - 2 * DAY), where).filter(
      (l) => l.at >= since
    )
  );
}

/** The reply as the model gives it, before the checks: strict, a field it invents refuses it. */
const Said = z.union([
  z
    .object({
      agreed: z.literal(true),
      allDay: z.boolean(),
      end: z.string().nullable(),
      link: z.string().nullable(),
      people: z.array(z.string()),
      place: z.string().nullable(),
      quote: z.string(),
      start: z.string(),
      title: z.string(),
      zone: z.string().nullable(),
    })
    .strict(),
  z.object({ agreed: z.literal(false) }).strict(),
]);
const Stored = ArrivalAppointmentReply.shape.reply;

/** A local time an hour later (`YYYY-MM-DD HH:MM`, no zone). */
const hourAfter = (local: string) =>
  iso(Date.parse(`${local.replace(" ", "T")}Z`) + HOUR)
    .slice(0, 16)
    .replace("T", " ");

const TIMED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const URLS = /https:\/\/[^\s<>"]+/g;
const TRAILING = /[.,;:!?'"\]>]+$/;

/** Whether `local` is a real calendar day (`YYYY-MM-DD`), or a real day and time (`YYYY-MM-DD HH:MM`) when `timed`. */
const isLocalTime = (local: string, timed: boolean) => {
  const shape = timed ? TIMED : DAY_ONLY;
  const at = Date.parse(
    `${local.replace(" ", "T")}${timed ? ":00" : "T00:00:00"}Z`
  );
  // A day or an hour out of range rolls over or fails to parse: written back, it is not the same text.
  return (
    shape.test(local) &&
    !Number.isNaN(at) &&
    iso(at).slice(0, local.length).replace("T", " ") === local
  );
};

/** The https addresses the lines hold, each whole: trailing punctuation and a closing bracket it did not open left out. */
const urlsOf = (lines: string[]) =>
  (lines.join("\n").match(URLS) ?? []).map((u) => {
    const trimmed = u.replace(TRAILING, "");
    const isOpen = (trimmed.match(/\(/g) ?? []).length;
    return trimmed.endsWith(")") && (trimmed.match(/\)/g) ?? []).length > isOpen
      ? trimmed.slice(0, -1)
      : trimmed;
  });

/** A link kept only when the lines hold that https address whole and it parses; else none (the appointment kept). */
const linkOf = (link: string | null, lines: string[]) =>
  link && URL.canParse(link) && urlsOf(lines).includes(link) ? link : null;

/** Why a reply that agrees is not kept, or null: its quote, its days and times, its zone. */
function problemOf(
  a: Extract<z.infer<typeof Said>, { agreed: true }>,
  read: {
    firstDay: string;
    lines: string[];
  }
) {
  const timed = !a.allDay;
  const at = locate(a.quote, read.lines);
  if (at === null || at.line !== at.lastLine) {
    return "its quote is not in one line";
  }
  if (
    !isLocalTime(a.start, timed) ||
    (a.end !== null && !isLocalTime(a.end, timed))
  ) {
    return "its days and times are not real ones, or disagree";
  }
  if (a.start.slice(0, 10) < read.firstDay) {
    return "it starts before the lines";
  }
  if ((a.end ?? a.start) < a.start) {
    return "it ends before it starts";
  }
  return null;
}

/**
 * The appointment read's reply as stored (`makeReplies`' `checked`): one that agrees, with its quote found in the lines
 * (stored as the lines say it), real days and times on both ends, of one precision (whole days written as days), a zone
 * the platform knows, a start on or after the lines' first day, an end on or after it (an hour after a timed start when
 * none is given, the same day for a whole one); a link kept only when an https address the lines hold whole (else
 * dropped, the appointment kept); at most 10 people, by name. Any other reply is stored as not agreed with why
 * (`refused`), so it is not asked again.
 */
export function checkedAppointmentReply(
  answer: unknown,
  read: { firstDay: string; lines: string[] }
): z.infer<typeof Stored> {
  const said = Said.safeParse(answer);
  if (!said.success) {
    return { agreed: false, refused: "not the reply's shape" };
  }
  const a = said.data;
  if (!a.agreed) {
    return a;
  }
  const why = problemOf(a, read);
  if (why) {
    return { agreed: false, refused: why };
  }
  const kept = {
    ...a,
    end: a.end ?? (a.allDay ? a.start : hourAfter(a.start)),
    link: linkOf(a.link, read.lines),
    people: a.people.slice(0, 10),
    quote: locate(a.quote, read.lines)?.verbatim ?? a.quote,
  };
  // A link the stored shape refuses is dropped alone.
  const stored =
    Stored.safeParse(kept).data ??
    Stored.safeParse({ ...kept, link: null }).data;
  return stored ?? { agreed: false, refused: "a field out of bounds" };
}
