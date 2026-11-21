import { z } from "zod";
import { isTimeZone } from "../core/time-zone";
import { LocalTime } from "./episode";
import { isoDateTime, MadeBy } from "./fields";
import { ObservationId } from "./observation";

// Memory's appointments (memory/appointments.json, memory/appointment-events.jsonl; docs/SCHEMA.md).

export const AppointmentId = z.string().regex(/^apt_[0-9a-f]{12}$/);

/** Something ahead of him that he is expected at, read from the facts ahead of him (`memory/appointments.ts`). */
export const Appointment = z
  .object({
    allDay: z.boolean(),
    /** Local, like `start`; the last day, inclusive, when `allDay`. */
    end: LocalTime,
    id: AppointmentId,
    /** The facts it was read from. */
    observations: z.array(ObservationId).min(1),
    place: z.string().min(1).max(200).nullable(),
    start: LocalTime,
    /** No fact gave the hour: the step chose one that makes sense. */
    timeGuessed: z.boolean(),
    title: z.string().min(1).max(200),
    /** The place's IANA zone its times are in, when not the zone he will be in then (`zoneAt`). */
    zone: z.string().refine(isTimeZone).nullable(),
  })
  .strict();
export type Appointment = z.infer<typeof Appointment>;

/** memory/appointments.json: every appointment ahead of him, rewritten whole when its inputs change (`inputs`). */
export const Appointments = z
  .object({
    appointments: z.array(Appointment),
    built: isoDateTime,
    inputs: z.string(),
    madeBy: MadeBy,
    schemaVersion: z.literal(1),
  })
  .strict();
export type Appointments = z.infer<typeof Appointments>;

/**
 * memory/appointment-events.jsonl, append-only, written by the calendar sync and his Remove and Undo
 * (`host/appointments-calendar.ts`): `created`, an event Life wrote for an appointment; `removed`, that event deleted by
 * Life (the appointment gone); `refused`, that event deleted by him (in his calendar, or by Remove), so it is never
 * written again; `restored`, his Undo of that, which lifts it. Each line names what the appointment was read from: its
 * facts (the night's), or the messages it was agreed in (the arrival reader's).
 */
export const AppointmentEvent = z
  .object({
    appointment: AppointmentId,
    at: isoDateTime,
    /** The calendar it was in (the `appointments` setting's then). */
    calendar: z.string().min(1),
    /** On his Remove of one he had confirmed (its event's `lifeConfirmed`), and its Undo: written again confirmed. */
    confirmed: z.literal(true).optional(),
    /** Its id in that calendar. */
    event: z.string().min(1),
    /** The keys of the messages an appointment agreed in new lines was read from (`eventKey`, or a turn's key). */
    messages: z.array(z.string().min(1)).min(1).optional(),
    observations: z.array(ObservationId).min(1).optional(),
    op: z.enum(["created", "removed", "refused", "restored"]),
    schemaVersion: z.literal(1),
  })
  .strict()
  .refine(
    (e) => (e.messages === undefined) !== (e.observations === undefined),
    {
      message: "its facts or its messages, one of the two",
    }
  );
export type AppointmentEvent = z.infer<typeof AppointmentEvent>;
