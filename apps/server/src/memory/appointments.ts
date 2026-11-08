import { z } from "zod";
import { readAppended, readJson } from "../core/files";
import { digest } from "../core/hash";
import { isTimeZone } from "../core/time-zone";
import { stamp } from "../models/llm";
import {
  Appointment,
  AppointmentEvent,
  AppointmentId,
  Appointments,
} from "../records/appointment";
import type { Observation } from "../records/observation";
import { ObservationId } from "../records/observation";
import {
  APPOINTMENT_EVENTS,
  APPOINTMENTS,
  type Standing,
  stateOf,
} from "./ledger";
import { begin } from "./run";
import { daysBefore } from "./units";
import { observationsNow, readPeople } from "./who";
import { zoneNow } from "./zones";

// The appointments step (his request, 8 Nov 2026): one call reads his active facts ahead of him and groups and
// times them into appointments, continuing the ids of those held. Extraction decides which fact holds; this step only
// reads what holds now. Rewritten whole when its inputs change. `host/appointments-calendar.ts` puts them in his
// calendar.

const APPOINTMENTS_PROMPT = "memory-appointments.v1";
/** An undated plan counts this many days after it was said. */
const UNDATED_DAYS = 30;

export const readAppointments = () =>
  Appointments.safeParse(readJson(APPOINTMENTS)).data ?? null;

/** What the calendar sync wrote: each appointment's latest event line, and the facts of each refused one. */
export const readAppointmentEvents = () =>
  readAppended(
    APPOINTMENT_EVENTS,
    AppointmentEvent,
    (last?: {
      byAppointment: Map<string, AppointmentEvent>;
      refused: string[][];
    }) => ({
      byAppointment: new Map(last?.byAppointment),
      refused: [...(last?.refused ?? [])],
    }),
    (acc, e) => {
      acc.byAppointment.set(e.appointment, e);
      if (e.op === "refused") {
        acc.refused.push(e.observations);
      }
    }
  );

/** His no holds for any appointment citing every fact of one he refused, whatever its id. */
export const isRefused = (
  facts: readonly string[],
  refused: readonly (readonly string[])[]
) => refused.some((r) => r.every((f) => facts.includes(f)));

/**
 * The facts the step reads: active ones for today or later (a confirmed booking is a fact; a hypothesis never), undated
 * plans said in the last `UNDATED_DAYS`, and every
 * active fact a held appointment cites, whatever its age.
 */
export function factsAheadOf(
  observations: Observation[],
  standing: Standing,
  today: string,
  held: ReadonlySet<string>
) {
  const since = daysBefore(today, UNDATED_DAYS);
  return observations.filter(
    (o) =>
      stateOf(o, standing).state === "active" &&
      (held.has(o.id) ||
        (o.when
          ? o.when >= today && o.modality !== "conditional"
          : o.modality === "plan" && o.date >= since))
  );
}

const Reply = z.object({
  allDay: z.boolean(),
  continues: AppointmentId.nullish(),
  end: Appointment.shape.end,
  facts: z.array(ObservationId).min(1),
  place: z.string().max(200).nullish(),
  start: Appointment.shape.start,
  timeGuessed: z.boolean().default(false),
  title: Appointment.shape.title,
  zone: z.string().nullish(),
});

/**
 * The model's reply checked: each appointment citing only facts it was shown, not refused (`isRefused`), ending today
 * or later, its zone one Intl knows; `continues` kept only when it names a held id, else a new id from its facts. One
 * appointment per id. A held one the reply leaves out stays while every fact it cites is shown (active), none is cited
 * by a kept one and it has not ended: it goes when its facts do, never by a reading that forgot it (its event may be
 * one he confirmed).
 */
export function checkedAppointments(
  reply: unknown,
  ctx: {
    held: readonly Appointment[];
    refused: readonly (readonly string[])[];
    shown: ReadonlySet<string>;
    today: string;
  }
) {
  const list = z
    .object({ appointments: z.array(z.unknown()) })
    .parse(reply).appointments;
  const heldIds = new Set(ctx.held.map((h) => h.id));
  const kept = new Map<string, Appointment>();
  let invalid = 0;
  for (const raw of list) {
    const a = Reply.safeParse(raw).data;
    // Whole days are written as days, timed ones with their hour, both edges alike.
    const ok =
      a?.facts.every((f) => ctx.shown.has(f)) &&
      a.allDay === !a.start.includes(" ") &&
      a.allDay === !a.end.includes(" ") &&
      !isRefused(a.facts, ctx.refused) &&
      (!a.zone || isTimeZone(a.zone)) &&
      a.end.slice(0, 10) >= ctx.today &&
      a.end >= a.start;
    const id =
      a?.continues && heldIds.has(a.continues)
        ? a.continues
        : `apt_${digest("sha1", (a?.facts ?? []).toSorted().join(" "), 12)}`;
    if (!(a && ok) || kept.has(id)) {
      invalid += 1;
      continue;
    }
    kept.set(id, {
      allDay: a.allDay,
      end: a.end,
      id,
      observations: a.facts,
      place: a.place ?? null,
      start: a.start,
      timeGuessed: a.timeGuessed,
      title: a.title,
      zone: a.zone ?? null,
    });
  }
  const cited = new Set([...kept.values()].flatMap((a) => a.observations));
  const stays = ctx.held.filter(
    (h) =>
      !kept.has(h.id) &&
      h.observations.every((f) => ctx.shown.has(f) && !cited.has(f)) &&
      !isRefused(h.observations, ctx.refused) &&
      h.end.slice(0, 10) >= ctx.today
  );
  return { appointments: [...kept.values(), ...stays], invalid };
}

/** The nightly step: the appointments ahead of him, read again when their facts, the held ones or his day changed. */
export async function appointments() {
  const step = await begin("appointments", "main", {
    prompt: APPOINTMENTS_PROMPT,
  });
  const { observations, standing } = await observationsNow(await readPeople());
  const last = readAppointments();
  const held = last?.appointments ?? [];
  const { refused } = readAppointmentEvents();
  const facts = factsAheadOf(
    observations,
    standing,
    step.today,
    new Set(held.flatMap((a) => a.observations))
  );
  const input = {
    facts: facts.map((o) => ({
      id: o.id,
      said: o.date,
      text: o.text,
      when: o.when,
    })),
    held: held.map((a) => ({
      end: a.end,
      facts: a.observations,
      id: a.id,
      start: a.start,
      title: a.title,
    })),
    here: zoneNow() ?? null,
    today: step.today,
  };
  const inputs = digest(
    "sha256",
    `${APPOINTMENTS_PROMPT}\n${JSON.stringify(input)}`,
    16
  );
  if (last?.inputs === inputs) {
    return step.end({ appointments: held.length, read: false });
  }
  // A failed call, or a reply with no appointment it could keep, keeps the last ones: the next night reads again.
  const checked =
    facts.length === 0
      ? { appointments: [], invalid: 0 }
      : await step.attempt(async () => {
          const reply = await step.ask({
            dir: step.dir,
            input,
            prompt: APPOINTMENTS_PROMPT,
          });
          const c = checkedAppointments(reply, {
            held,
            refused,
            shown: new Set(facts.map((o) => o.id)),
            today: step.today,
          });
          if (c.appointments.length === 0 && c.invalid > 0) {
            throw new Error(`no valid appointment (${c.invalid} invalid)`);
          }
          return c;
        });
  if (!checked) {
    return step.end({ appointments: held.length, read: false });
  }
  const { appointments: found, invalid } = checked;
  const file: Appointments = {
    appointments: found,
    built: step.now.toISOString(),
    inputs,
    madeBy: stamp(step.llm, APPOINTMENTS_PROMPT, step.run),
    schemaVersion: 1,
  };
  await Bun.write(APPOINTMENTS, `${JSON.stringify(file, null, 1)}\n`);
  return step.end({ appointments: found.length, invalid, read: true });
}
