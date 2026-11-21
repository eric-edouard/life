import { existsSync } from "node:fs";
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
import {
  type ArrivalAppointment,
  meetingKeyOf,
  readArrivalAppointments,
} from "../memory/arrival-appointments";
import {
  DESCRIPTION_MAX,
  type Draft,
  heldOf,
  mapLinksOf,
  reconcile,
} from "../memory/calendar-events";
import { span } from "../memory/episode-span";
import { APPOINTMENT_EVENTS, APPOINTMENTS } from "../memory/memory-files";
import { clip } from "../memory/units";
import { dayNow, dayStart } from "../memory/zones";
import { type Appointment, AppointmentEvent } from "../records/appointment";
import { notifyPhone, pushIdOf } from "../sources/lifelog-push";
import { levelOf, NOTIFY_DEFAULTS } from "./card-push";
import { type GoogleCalendar, googleCalendar } from "./google-calendar";

// The appointments in his calendar (his request, 8 Nov 2026): `memory/appointments.json` and the appointments agreed
// in new lines (`memory/arrival-appointments.ts`, his word of 21 Nov 2026) brought into the `appointments` setting's
// calendar, his own, so his agents plan around them. Only the watcher syncs, one sync at a time (`inTurn`): every
// 30 minutes. An appointment's first event pushes `calendar.added`. Life touches only its own events there
// (found by `lifeOutput=appointments`) and reads back of them only `lifeConfirmed`, which an agent sets once he
// confirms one. An event he or an agent removed is his no: recorded as `refused`, it is never
// written again, until he lifts it (`restored`). One Life removes (its appointment gone) is recorded as `removed`, so the
// same appointment coming back is written again.

const OUTPUT = { lifeOutput: "appointments" } as const;
/** How far ahead Life lists its events. */
const AHEAD = 400 * DAY;

/** What the sync writes: one of the night's appointments (with `agreed` when he agreed it in new lines), or one agreed in new lines. */
type Planned =
  | (Appointment & { agreed?: { link: string | null; unit?: string } })
  | ArrivalAppointment;
const isArrival = (a: Planned): a is ArrivalAppointment => "messages" in a;
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
    "appointment" | "calendar" | "event" | "messages" | "observations"
  >,
  now: Date
) => {
  appendJsonl(APPOINTMENT_EVENTS, AppointmentEvent, [
    AppointmentEvent.parse({
      appointment: e.appointment,
      at: now.toISOString(),
      calendar: e.calendar,
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
 * The appointments to draft now in `calendar`: each one not refused whose event is listed, or was never written there
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

/** Whether an appointment's event ends after `now` (its own instant, in its zone). */
const isAhead = (a: Planned, now: Date) => {
  const { allDay, to } = span(
    { day: a.start.slice(0, 10), end: a.end, start: a.start },
    a.zone ?? undefined
  );
  // A whole day ends at midnight where it is.
  const end = allDay ? dayStart(to, a.zone ?? undefined) : new Date(to);
  return end.getTime() > now.getTime();
};

/**
 * One draft per meeting: a night's appointment and an arrival of the same id or meeting (`meetingKeyOf`) are one, with the night's
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
      ahead.find(
        (x) => meetingKeyOf(x) === meetingKeyOf(n) && !joined.has(x.id)
      );
    if (!a) {
      const agreed = agreedOn.get(n.id);
      return agreed ? { ...n, agreed } : n;
    }
    joined.add(a.id);
    return {
      ...n,
      agreed: { link: a.link, unit: a.unit },
      id: hasEvent(n.id) ? n.id : a.id,
    };
  });
  return [...nights, ...ahead.filter((a) => !joined.has(a.id))];
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

let turn: Promise<unknown> = Promise.resolve();
/** One sync at a time: the watcher's ticks share this chain (and his Remove and Undo, next). */
function inTurn<T>(run: () => Promise<T>) {
  const next = turn.then(run);
  turn = next.catch(() => undefined);
  return next;
}

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
  // From the start of his day: an event that ended before is never touched.
  const listed = await cal.list(
    dayStart(today).toISOString(),
    iso(now.getTime() + AHEAD),
    `lifeOutput=${OUTPUT.lifeOutput}`
  );
  const held = heldOf(
    listed.map((e) => ({
      allDay: e.allDay,
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
  const known = readAppointmentEvents().byAppointment;
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
  // every event stays: none is removed for want of the night's reading.
  const isKept = (of: string) => {
    const last = events.byAppointment.get(of);
    return !file || (last?.op === "created" && last.messages !== undefined);
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
