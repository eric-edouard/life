import { z } from "zod";
import { readAppended, readJson } from "../core/files";
import { digest } from "../core/hash";
import { stamp } from "../models/llm";
import {
  Appointment,
  AppointmentEvent,
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
import { begin, checkedEntries } from "./run";
import { daysBefore } from "./units";
import { observationsNow, readPeople } from "./who";
import { zoneNow } from "./zones";

// The appointments step (his request, 8 Nov 2026): one call reads his active facts ahead of him and groups and
// times them into appointments; code keeps the ids of those held. Extraction decides which fact holds; this step only
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
const isRefused = (
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

/** One appointment as the model gives it: a place it writes empty or too long is no place. */
const Reply = z.object({
  allDay: Appointment.shape.allDay,
  end: Appointment.shape.end,
  facts: z.array(ObservationId).min(1),
  place: Appointment.shape.place.catch(null),
  start: Appointment.shape.start,
  timeGuessed: z.boolean().default(false),
  title: Appointment.shape.title,
  zone: Appointment.shape.zone.default(null),
});

/**
 * Which held appointment each reading is: the pairs sharing facts, the most alike first (shared over all their
 * facts), each held id to one reading at most; undefined for a new one.
 */
export function heldIdsOf(
  readings: readonly (readonly string[])[],
  held: readonly { facts: readonly string[]; id: string }[]
) {
  const pairs = readings
    .flatMap((r, i) =>
      held.map((h) => ({
        i,
        id: h.id,
        score:
          r.filter((f) => h.facts.includes(f)).length /
          new Set([...r, ...h.facts]).size,
      }))
    )
    .filter((p) => p.score > 0)
    .toSorted((a, b) => b.score - a.score);
  const ids: (string | undefined)[] = readings.map(() => undefined);
  const taken = new Set<string>();
  for (const p of pairs) {
    if (ids[p.i] === undefined && !taken.has(p.id)) {
      ids[p.i] = p.id;
      taken.add(p.id);
    }
  }
  return ids;
}

/**
 * The model's reply checked: each appointment citing only facts it was shown, not refused (`isRefused`), ending today
 * or later, once per set of facts. Code keeps the ids: a reading takes the id of the held appointment it shares the
 * most facts with (a fact a newer one replaced counts as the newer, `replacedBy`), else a new id from its facts. A held
 * one the reply leaves out stays while every fact it cites is shown (active), none is cited by a kept one and it has
 * not ended: it goes when its facts do, never by a reading that forgot it (its event may be one he confirmed).
 */
export function checkedAppointments(
  reply: unknown,
  ctx: {
    held: readonly Appointment[];
    refused: readonly (readonly string[])[];
    replacedBy: (fact: string) => string | undefined;
    shown: ReadonlySet<string>;
    today: string;
  }
) {
  // Whole days are written as days, timed ones with their hour, both edges alike.
  const valid = Reply.refine(
    (a) =>
      a.facts.every((f) => ctx.shown.has(f)) &&
      a.allDay === !a.start.includes(" ") &&
      a.allDay === !a.end.includes(" ") &&
      !isRefused(a.facts, ctx.refused) &&
      a.end.slice(0, 10) >= ctx.today &&
      a.end >= a.start
  );
  const factsOf = (facts: readonly string[]) => facts.toSorted().join(" ");
  const { entries, invalid } = checkedEntries(
    z.object({ appointments: z.array(z.unknown()) }).parse(reply).appointments,
    valid,
    (a) => factsOf(a.facts),
    () => true
  );
  const ids = heldIdsOf(
    entries.map((a) => a.facts),
    ctx.held.map((h) => ({
      facts: h.observations.map((f) => ctx.replacedBy(f) ?? f),
      id: h.id,
    }))
  );
  // A new id is its facts' hash, hashed again while another appointment has it (a held one first read from them).
  const used = new Set([...ctx.held.map((h) => h.id), ...ids.filter(Boolean)]);
  const newId = (facts: readonly string[]) => {
    let id = `apt_${digest("sha1", factsOf(facts), 12)}`;
    while (used.has(id)) {
      id = `apt_${digest("sha1", id, 12)}`;
    }
    used.add(id);
    return id;
  };
  const kept = entries.map(
    ({ facts, ...a }, i): Appointment => ({
      ...a,
      id: ids[i] ?? newId(facts),
      observations: facts,
    })
  );
  const keptIds = new Set(kept.map((a) => a.id));
  const cited = new Set(kept.flatMap((a) => a.observations));
  const stays = ctx.held.filter(
    (h) =>
      !keptIds.has(h.id) &&
      h.observations.every((f) => ctx.shown.has(f) && !cited.has(f)) &&
      !isRefused(h.observations, ctx.refused) &&
      h.end.slice(0, 10) >= ctx.today
  );
  return { appointments: [...kept, ...stays], invalid };
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
            replacedBy: (f) => standing.retired.get(f)?.by,
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
