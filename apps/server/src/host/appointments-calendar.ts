import { clock, DAY, iso } from "../core/clock";
import { appendJsonl } from "../core/files";
import { digest } from "../core/hash";
import { log } from "../core/log";
import { isOn } from "../core/outputs";
import { settings } from "../core/settings";
import {
  readAppointmentEvents,
  readAppointments,
} from "../memory/appointments";
import { type Draft, heldOf, reconcile } from "../memory/calendar-events";
import { span } from "../memory/episode-span";
import { APPOINTMENT_EVENTS } from "../memory/ledger";
import { dayNow, dayStart } from "../memory/zones";
import { type Appointment, AppointmentEvent } from "../records/appointment";
import { type GoogleCalendar, googleCalendar } from "./google-calendar";

// The appointments in his calendar (his request, 8 Nov 2026): `memory/appointments.json` brought into the
// `appointments` setting's calendar, his own, so his agents plan around them. Life touches only its own events there
// (found by `lifeOutput=appointments`) and reads back of them only `lifeConfirmed`, which an agent sets once he
// confirms one. An event he or an agent removed is his no: recorded as `refused`, it is never written again. One Life
// removes (its appointment gone) is recorded as `removed`, so the same appointment coming back is written again.

const OUTPUT = { lifeOutput: "appointments" } as const;
/** How far ahead Life lists its events. */
const AHEAD = 400 * DAY;

/** One appointment as its event: marked `(Life)` and shown as free until confirmed. */
export function appointmentDraft(
  a: Appointment,
  isConfirmed: boolean
): Draft & { isConfirmed: boolean } {
  const when = span(
    { day: a.start.slice(0, 10), end: a.end, start: a.start },
    a.zone ?? undefined
  );
  const text = [
    isConfirmed
      ? "Added by Life from your messages, confirmed."
      : "Added by Life from your messages, not confirmed yet.",
    ...(a.timeGuessed ? ["The time is Life's guess."] : []),
    `Appointment ${a.id}, read from ${a.observations.join(", ")}.`,
  ].join("\n");
  const draft = {
    ...when,
    isConfirmed,
    of: a.id,
    place: a.place,
    summary: isConfirmed ? a.title : `(Life) ${a.title}`,
    text,
  };
  return { ...draft, hash: digest("sha1", JSON.stringify(draft), 12) };
}

const fieldsOf = (d: ReturnType<typeof appointmentDraft>) => ({
  allDay: d.allDay,
  busy: d.isConfirmed,
  description: d.text,
  from: d.from,
  location: d.place,
  // A reminder on screen only: a mail would come back into memory as a message.
  reminders: ["popup:30m"],
  summary: d.summary,
  to: d.to,
});

const line = (
  op: AppointmentEvent["op"],
  a: Pick<Appointment, "id" | "observations">,
  event: string,
  now: Date
) =>
  AppointmentEvent.parse({
    appointment: a.id,
    at: now.toISOString(),
    event,
    observations: a.observations,
    op,
    schemaVersion: 1,
  });

/**
 * The appointments to draft now: each one not refused whose event is listed, or was never written, or Life removed.
 * One Life wrote and no longer lists is looked up by its id: gone is a refusal (recorded); still there (outside the
 * listing) or a failed lookup leaves it for the next tick.
 */
export async function drafted(
  list: Appointment[],
  held: ReadonlyMap<string, unknown>,
  cal: Pick<GoogleCalendar, "exists">,
  now: Date
) {
  const { byAppointment } = readAppointmentEvents();
  const kept: Appointment[] = [];
  for (const a of list) {
    const last = byAppointment.get(a.id);
    if (held.has(a.id) || !last || last.op === "removed") {
      kept.push(a);
    } else if (last.op === "created") {
      // biome-ignore lint/performance/noAwaitInLoops: one call at a time, Google's rate limit
      const isThere = await cal.exists(last.event).catch(() => true);
      if (!isThere) {
        appendJsonl(APPOINTMENT_EVENTS, AppointmentEvent, [
          line("refused", a, last.event, now),
        ]);
        log("calendar.write", {
          appointment: a.id,
          event: last.event,
          op: "refused",
        });
      }
    }
  }
  return kept;
}

/** Brings his calendar in line with the appointments; null when it is not set up or there are none yet. */
export async function syncAppointments(now = clock()) {
  const { appointments } = settings();
  const file = readAppointments();
  if (!(appointments && isOn("appointments") && file)) {
    return null;
  }
  const cal = googleCalendar(appointments.calendar, appointments.account);
  // From the start of his day: an event that ended before is never touched.
  const listed = await cal.list(
    dayStart(dayNow(now)).toISOString(),
    iso(now.getTime() + AHEAD),
    `lifeOutput=${OUTPUT.lifeOutput}`
  );
  const held = heldOf(
    listed.map((e) => ({
      hash: e.props.lifeHash,
      id: e.id,
      of: e.props.lifeAppointment ?? "",
    }))
  );
  const confirmed = new Set(
    listed.flatMap((e) =>
      e.props.lifeConfirmed === "yes" ? [e.props.lifeAppointment ?? ""] : []
    )
  );
  const list = await drafted(file.appointments, held, cal, now);
  const byId = new Map(list.map((a) => [a.id, a]));
  const { create, remove, update } = reconcile(
    list.map((a) => appointmentDraft(a, confirmed.has(a.id))),
    held
  );
  const props = (d: ReturnType<typeof appointmentDraft>) => ({
    ...OUTPUT,
    lifeAppointment: d.of,
    lifeHash: d.hash,
    ...(d.isConfirmed ? { lifeConfirmed: "yes" } : {}),
  });
  for (const e of remove) {
    // biome-ignore lint/performance/noAwaitInLoops: one call at a time, Google's rate limit
    await cal.remove(e.id);
    const last = readAppointmentEvents().byAppointment.get(e.of);
    if (last?.event === e.id) {
      appendJsonl(APPOINTMENT_EVENTS, AppointmentEvent, [
        line(
          "removed",
          { id: e.of, observations: last.observations },
          e.id,
          now
        ),
      ]);
    }
    log("calendar.write", { appointment: e.of, event: e.id, op: "delete" });
  }
  for (const { d, id } of update) {
    // biome-ignore lint/performance/noAwaitInLoops: one call at a time, Google's rate limit
    await cal.update(id, fieldsOf(d), props(d));
    log("calendar.write", { appointment: d.of, event: id, op: "update" });
  }
  for (const d of create) {
    // biome-ignore lint/performance/noAwaitInLoops: one call at a time, Google's rate limit
    const event = await cal.create(fieldsOf(d), props(d));
    appendJsonl(APPOINTMENT_EVENTS, AppointmentEvent, [
      line("created", byId.get(d.of) as Appointment, event, now),
    ]);
    log("calendar.write", { appointment: d.of, event, op: "create" });
  }
  return {
    appointments: list.length,
    created: create.length,
    removed: remove.length,
    updated: update.length,
  };
}
