import { existsSync } from "node:fs";
import { clock, DAY, iso } from "../core/clock";
import { appendJsonl } from "../core/files";
import { digest } from "../core/hash";
import { oneAtATime } from "../core/lock";
import { log } from "../core/log";
import { isOn } from "../core/outputs";
import { settings } from "../core/settings";
import {
  readAppointmentEvents,
  readAppointments,
} from "../memory/appointments";
import { readArrivalAppointments } from "../memory/arrival-appointments";
import {
  DESCRIPTION_MAX,
  type Draft,
  heldOf,
  mapLinksOf,
  reconcile,
} from "../memory/calendar-events";
import { span } from "../memory/episode-span";
import { APPOINTMENT_EVENTS, APPOINTMENTS } from "../memory/memory-files";
import {
  isArrival,
  type Planned,
  plannedOf,
} from "../memory/planned-appointments";
import { clip } from "../memory/units";
import { dayNow, dayStart } from "../memory/zones";
import { AppointmentEvent } from "../records/appointment";
import { notifyPhone, pushIdOf } from "../sources/lifelog-push";
import { levelOf, NOTIFY_DEFAULTS } from "./card-push";
import { type GoogleCalendar, googleCalendar } from "./google-calendar";

// The appointments in his calendar (his request, 8 Nov 2026): `memory/appointments.json` and the appointments agreed
// in new lines (`memory/arrival-appointments.ts`, his word of 21 Nov 2026) brought into the `appointments` setting's
// calendar, his own, so his agents plan around them. Only the watcher syncs, one sync at a time (`inTurn`): every
// 30 minutes, and on his Remove or Undo from the connector. An appointment's first event pushes `calendar.added`. Life touches only its own events there
// (found by `lifeOutput=appointments`) and reads back of them only `lifeConfirmed`, which an agent sets once he
// confirms one. An event he or an agent removed, or he removed by Remove, is his no: recorded as
// `refused`, it is never written again, until his Undo (`restored`). One Life removes (its appointment gone) is recorded as `removed`, so the
// same appointment coming back is written again.

const OUTPUT = { lifeOutput: "appointments" } as const;
/** How far ahead Life lists its events. */
const AHEAD = 400 * DAY;

/** Whether he agreed it in new lines, and its meeting link: kept on its event too (`lifeAgreed`, `lifeLink`, `lifeUnit`), past the window the arrival is read in. */
const agreedOf = (a: Planned) =>
  isArrival(a) ? { link: a.link, unit: a.unit } : a.agreed;

/** What an appointment was read from, as its event lines name it: its facts, or its messages. */
const citesOf = (a: Planned) =>
  isArrival(a) ? { messages: a.messages } : { observations: a.observations };

/** One appointment as its event: marked `(Life)` and shown as free until confirmed. */
export function appointmentDraft(a: Planned, isConfirmed: boolean) {
  const when = span(
    { day: a.start.slice(0, 10), end: a.end, start: a.start },
    a.zone ?? undefined
  );
  const lines = [
    isConfirmed
      ? "Added by Life from your messages, confirmed."
      : "Added by Life from your messages, not confirmed yet.",
    ...(!isArrival(a) && a.timeGuessed ? ["The time is Life's guess."] : []),
    ...mapLinksOf({ name: a.place }),
    ...(agreedOf(a)?.link ? [`Meeting link: ${agreedOf(a)?.link}`] : []),
    ...(agreedOf(a)?.unit ? [`Agreed in ${agreedOf(a)?.unit}.`] : []),
    isArrival(a)
      ? `Appointment ${a.id}.`
      : `Appointment ${a.id}, read from ${a.observations.join(", ")}.`,
  ].join("\n");
  // A long list of facts is cut, never the links above it.
  const text = clip(lines, DESCRIPTION_MAX);
  const draft = {
    ...when,
    isConfirmed,
    ...citesOf(a),
    ...(agreedOf(a) ? { agreed: agreedOf(a) } : {}),
    of: a.id,
    place: a.place,
    summary: isConfirmed ? a.title : `(Life) ${a.title}`,
    text,
  };
  return { ...draft, hash: digest("sha1", JSON.stringify(draft), 12) };
}
type AppointmentDraft = ReturnType<typeof appointmentDraft> & Draft;

const fieldsOf = (d: AppointmentDraft) => ({
  ...d,
  // One he agreed in new lines is busy at once (his word of 21 Nov 2026); one Life only read is free until confirmed.
  busy: d.isConfirmed || d.agreed !== undefined,
  description: d.text,
  location: d.place,
  // A reminder on screen only: a mail would come back into memory as a message.
  reminders: ["popup:30m"],
});

/** Appends one line to `appointment-events.jsonl`. */
const appendEvent = (
  op: AppointmentEvent["op"],
  e: Pick<
    AppointmentEvent,
    | "appointment"
    | "calendar"
    | "confirmed"
    | "event"
    | "messages"
    | "observations"
  >,
  now: Date
) => {
  appendJsonl(APPOINTMENT_EVENTS, AppointmentEvent, [
    AppointmentEvent.parse({
      appointment: e.appointment,
      at: now.toISOString(),
      calendar: e.calendar,
      // His confirmation travels only from his Remove to its Undo; a written event holds it itself.
      ...(e.confirmed && op !== "created" ? { confirmed: true } : {}),
      event: e.event,
      ...(e.messages
        ? { messages: e.messages }
        : { observations: e.observations }),
      op,
      schemaVersion: 1,
    }),
  ]);
  log("calendar.write", { appointment: e.appointment, event: e.event, op });
};

/**
 * The appointments to draft now in `calendar`: each one not refused (his no holds in every calendar) whose event is listed, or was never written there
 * (another calendar's event is not his no), or Life removed, or he restored. One Life wrote there and no longer lists
 * is looked up by its id: gone is a refusal (recorded); still there (outside the listing) or a failed lookup leaves it
 * for the next tick.
 */
export async function drafted<A extends Planned>(
  list: A[],
  held: ReadonlyMap<string, unknown>,
  cal: Pick<GoogleCalendar, "exists">,
  calendar: string,
  now: Date
) {
  const { byAppointment } = readAppointmentEvents();
  const kept: A[] = [];
  for (const a of list) {
    const last = byAppointment.get(a.id);
    if (last?.op === "refused") {
      // His no, in any calendar, even while Google still lists the event his Remove deleted.
      continue;
    }
    if (
      held.has(a.id) ||
      !last ||
      last.op === "removed" ||
      last.op === "restored" ||
      last.calendar !== calendar
    ) {
      kept.push(a);
    } else if (last.op === "created") {
      // biome-ignore lint/performance/noAwaitInLoops: one call at a time, Google's rate limit
      const isThere = await cal.exists(last.event).catch(() => true);
      if (!isThere) {
        appendEvent("refused", last, now);
      }
    }
  }
  return kept;
}

/** The push for an appointment's first event: an opaque id; the phone reads the event from the connector and writes the words. */
async function pushAdded(d: AppointmentDraft, now: Date) {
  const setting = settings().notifications.calendar ?? NOTIFY_DEFAULTS.calendar;
  if (setting !== "off") {
    await notifyPhone({
      body: "Added to your calendar",
      kind: "calendar.added",
      level: levelOf(setting, d.from, now),
      pushId: pushIdOf(d.of),
      title: "Life",
    });
  }
}

/** One sync, Remove or Undo at a time: the watcher's ticks and the connector's calls share this chain. */
const inTurn = oneAtATime();

/** Brings his calendar in line with the appointments; null when it is not set up, or the night is rewriting its file. */
async function sync(now: Date) {
  const { appointmentsCalendar: appointments } = settings();
  if (!(appointments && isOn("appointmentsCalendar"))) {
    return null;
  }
  const file = readAppointments();
  if (!file && existsSync(APPOINTMENTS)) {
    return null;
  }
  const today = dayNow(now);
  const cal = googleCalendar(appointments.calendar, appointments.account);
  const known = readAppointmentEvents().byAppointment;
  // An event his Remove deleted is gone, even while Google still lists it.
  const isDeleted = (id: string, of = "") => {
    const last = known.get(of);
    return (
      (last?.op === "refused" || last?.op === "restored") && last.event === id
    );
  };
  // From the start of his day: an event that ended before is never touched.
  const listed = (
    await cal.list(
      dayStart(today).toISOString(),
      iso(now.getTime() + AHEAD),
      `lifeOutput=${OUTPUT.lifeOutput}`
    )
  ).filter((e) => !isDeleted(e.id, e.props.lifeAppointment));
  // Of two events of one appointment, the one its last line wrote is kept, the other removed (a deleted one Google
  // still lists after his Undo wrote it again).
  const isWritten = (e: (typeof listed)[number]) =>
    known.get(e.props.lifeAppointment ?? "")?.event === e.id;
  const held = heldOf(
    listed
      .toSorted((a, b) => Number(isWritten(b)) - Number(isWritten(a)))
      .map((e) => ({
        allDay: e.allDay,
        hash: e.props.lifeHash,
        id: e.id,
        of: e.props.lifeAppointment ?? "",
      }))
  );
  // Confirmed: its event says so, or his Undo brings back one he had confirmed.
  const confirmed = new Set([
    ...listed.flatMap((e) =>
      e.props.lifeConfirmed === "yes" ? [e.props.lifeAppointment ?? ""] : []
    ),
    ...[...known].flatMap(([of, l]) =>
      l.op === "restored" && l.confirmed ? [of] : []
    ),
  ]);
  const agreedOn = new Map(
    listed.flatMap((e) =>
      e.props.lifeAgreed === "yes"
        ? [
            [
              e.props.lifeAppointment ?? "",
              {
                link: e.props.lifeLink ?? null,
                ...(e.props.lifeUnit ? { unit: e.props.lifeUnit } : {}),
              },
            ],
          ]
        : []
    )
  );
  const list = await drafted(
    plannedOf(
      file?.appointments ?? [],
      readArrivalAppointments(now),
      agreedOn,
      (id) => known.has(id),
      now
    ),
    held,
    cal,
    appointments.calendar,
    now
  );
  const events = readAppointmentEvents();
  // An arrival's event stays until it ends, past the window it is read in; with no night file yet (a new install),
  // every event stays: none is removed for want of the night's reading. One he removed never stays.
  const isKept = (of: string) => {
    const last = events.byAppointment.get(of);
    return (
      last?.op !== "refused" &&
      (!file || (last?.op === "created" && last.messages !== undefined))
    );
  };
  const { create, remove, update } = reconcile(
    list.map((a) => appointmentDraft(a, confirmed.has(a.id))),
    held,
    isKept
  );
  const props = (d: AppointmentDraft) => ({
    ...OUTPUT,
    lifeAppointment: d.of,
    lifeHash: d.hash,
    ...(d.isConfirmed ? { lifeConfirmed: "yes" } : {}),
    ...(d.agreed ? { lifeAgreed: "yes" } : {}),
    ...(d.agreed?.link ? { lifeLink: d.agreed.link } : {}),
    ...(d.agreed?.unit ? { lifeUnit: d.agreed.unit } : {}),
  });
  for (const e of remove) {
    // Recorded first: a crash before the delete leaves an event the next tick removes again, never a false refusal.
    // Only over `created`: his no (`refused`) is never written over.
    const last = readAppointmentEvents().byAppointment.get(e.of);
    if (last?.event === e.id && last.op === "created") {
      appendEvent("removed", last, now);
    }
    // biome-ignore lint/performance/noAwaitInLoops: one call at a time, Google's rate limit
    await cal.remove(e.id);
  }
  for (const { d, id } of update) {
    // biome-ignore lint/performance/noAwaitInLoops: one call at a time, Google's rate limit
    await cal.update(id, fieldsOf(d), props(d));
    log("calendar.write", { appointment: d.of, event: id, op: "update" });
  }
  for (const d of create) {
    // biome-ignore lint/performance/noAwaitInLoops: one call at a time, Google's rate limit
    const event = await cal.create(fieldsOf(d), props(d));
    appendEvent(
      "created",
      { ...d, appointment: d.of, calendar: appointments.calendar, event },
      now
    );
    if (!events.created.has(d.of)) {
      await pushAdded(d, now);
    }
  }
  return {
    appointments: list.length,
    created: create.length,
    removed: remove.length,
    updated: update.length,
  };
}

/** The watcher's sync, in turn. */
export const syncAppointments = (now = clock()) => inTurn(() => sync(now));

type Changed =
  | { result: "removed" | "restored" }
  | { reason: string; result: "failed" };
const failed = (reason: string): Changed => ({ reason, result: "failed" });

/**
 * His Remove (his token only, `change_appointment`): Google deletes the event (already gone counts), then his no is
 * recorded (`refused`), so it is never written again; a failed delete records nothing.
 */
export const removeAppointment = (id: string, now = clock()) =>
  inTurn(async (): Promise<Changed> => {
    const { appointmentsCalendar: s } = settings();
    const last = readAppointmentEvents().byAppointment.get(id);
    if (!(s && isOn("appointmentsCalendar"))) {
      return failed("the calendar is off");
    }
    if (last?.op !== "created") {
      return last?.op === "refused"
        ? { result: "removed" }
        : failed("it is not in your calendar");
    }
    const cal = googleCalendar(last.calendar, s.account);
    let wasConfirmed = false;
    try {
      const props = (await cal.read(last.event))?.props;
      wasConfirmed = props?.lifeConfirmed === "yes";
      await cal.remove(last.event);
    } catch (e) {
      return failed((e as Error).message);
    }
    appendEvent(
      "refused",
      { ...last, confirmed: wasConfirmed || undefined },
      now
    );
    return { result: "removed" };
  });

/**
 * His Undo of a Remove: his no is lifted (`restored`) and the sync writes the event again; when it cannot (a sync
 * failed, or Life no longer holds the appointment), his no is recorded again.
 */
export const restoreAppointment = (id: string, now = clock()) =>
  inTurn(async (): Promise<Changed> => {
    const last = readAppointmentEvents().byAppointment.get(id);
    if (last?.op !== "refused") {
      return last?.op === "created"
        ? { result: "restored" }
        : failed("it was not removed");
    }
    appendEvent("restored", last, now);
    const error = await sync(now).then(
      () => null,
      (e: Error) => e.message
    );
    // Its own outcome, never the whole sync's: written again, it is restored whatever failed after it.
    if (readAppointmentEvents().byAppointment.get(id)?.op === "created") {
      return { result: "restored" };
    }
    appendEvent("refused", last, now);
    return failed(error ?? "Life no longer holds it, or the calendar is off");
  });
