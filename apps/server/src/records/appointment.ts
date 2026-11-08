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
 * memory/appointment-events.jsonl, append-only, written by the calendar sync (`host/appointments-calendar.ts`):
 * `created`, an event Life wrote for an appointment; `removed`, that event deleted by Life (the appointment gone);
 * `refused`, that event deleted by hand (his no), so no appointment citing all its facts is written again.
 */
export const AppointmentEvent = z
  .object({
    appointment: AppointmentId,
    at: isoDateTime,
    /** Its id in his calendar. */
    event: z.string().min(1),
    observations: z.array(ObservationId).min(1),
    op: z.enum(["created", "removed", "refused"]),
    schemaVersion: z.literal(1),
  })
  .strict();
export type AppointmentEvent = z.infer<typeof AppointmentEvent>;
