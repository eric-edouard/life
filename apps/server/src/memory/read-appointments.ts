import { clock, DAY, iso } from "../core/clock";
import { redact } from "../core/redact";
import type { SourceEvent } from "../records/source";
import { pushIdOf } from "../sources/voice-server-push";
import { readAppointmentEvents, readAppointments } from "./appointments";
import {
  ARRIVAL_APPOINTMENT_DAYS,
  readArrivalAppointments,
} from "./arrival-appointments";
import { span } from "./episode-span";
import { matterOfSteps } from "./matter-read";
import type { readMatterBook } from "./matters";
import { readIndex } from "./memory-files";
import { messageWordsOf } from "./message-files";
import { isArrival, type Planned, plannedOf } from "./planned-appointments";
import { clip, speakerOf } from "./units";
import type { People } from "./who";

// One appointment as the phone's event sheet shows it (the designer's ruling of 21 Nov 2026): `read_appointments` by
// its push's id or its own, and `fetch` of its `apt_` ref. Worked out when read from the night's appointments, the
// arrival's (`memory/arrival-appointments.ts`) and the calendar sync's lines; nothing is stored for it.

/** What the sheet reads, once per request: the people, the matter book, and a message by its key (`find-refs.ts`). */
export interface AppointmentReads {
  book: () => ReturnType<typeof readMatterBook>;
  message: (key: string) => SourceEvent | null;
  people: () => Promise<People>;
}

/** The message an appointment was read from: the arrival's one holding its quote (else its newest), else the night's first fact that opens. */
function sourceMessageOf(
  a: { messages: string[]; quote: string } | undefined,
  observations: readonly string[],
  reads: AppointmentReads
) {
  if (a) {
    const events = a.messages.toReversed().map(reads.message);
    const quoted = events.find((e) =>
      e ? messageWordsOf(e.text).includes(a.quote) : false
    );
    const found = quoted ?? events.find(Boolean);
    if (found) {
      return found;
    }
  }
  for (const id of observations) {
    const ref = readIndex((db) =>
      db
        .query<{ channel: string; ref: string }, [string]>(
          "select channel, ref from observations where id = ?"
        )
        .get(id)
    );
    const e = ref && reads.message(`${ref.channel}|${ref.ref}`);
    if (e) {
      return e;
    }
  }
  return null;
}

/**
 * The appointment `q` names (its id, or its push's id), only one the sync wrote (an event line), as the calendar holds
 * it: the night's reading, and the arrival of the same id or meeting (read back to its first event, past the arrival's
 * window); null when Life holds none.
 */
function writtenAppointmentOf(
  q: { appointment?: string; pushId?: string },
  now: Date
) {
  const { byAppointment, created } = readAppointmentEvents();
  const id =
    q.appointment ??
    [...byAppointment.keys()].find((k) => pushIdOf(k) === q.pushId);
  const last = id === undefined ? undefined : byAppointment.get(id);
  if (!(id && last)) {
    return null;
  }
  const firstAt = created.get(id);
  // Every arrival the sync could have read when it first wrote it: its whole window before that.
  const arrivals = readArrivalAppointments(
    now,
    undefined,
    firstAt && iso(Date.parse(firstAt) - ARRIVAL_APPOINTMENT_DAYS * DAY)
  );
  const night = readAppointments()?.appointments ?? [];
  // The sync's own choice (`plannedOf`); one already over is as it was read.
  const a: Planned | undefined =
    plannedOf(
      night,
      arrivals,
      new Map(),
      (k) => byAppointment.has(k),
      now
    ).find((p) => p.id === id) ??
    night.find((x) => x.id === id) ??
    arrivals.find((x) => x.id === id);
  if (!a) {
    return null;
  }
  const arrival = isArrival(a) ? a : a.arrival;
  return {
    a,
    arrival,
    firstAt,
    id,
    last,
    observations: isArrival(a) ? [] : a.observations,
  };
}

/** The appointment `q` names as the sheet shows it (`writtenAppointmentOf`); null when Life holds none. */
export async function readAppointmentSheet(
  q: { appointment?: string; pushId?: string },
  reads: AppointmentReads,
  now = clock()
) {
  const held = writtenAppointmentOf(q, now);
  if (!held) {
    return null;
  }
  const { a, arrival, firstAt, id, last, observations } = held;
  const when = span(
    { day: a.start.slice(0, 10), end: a.end, start: a.start },
    a.zone ?? undefined
  );
  const e = sourceMessageOf(arrival, observations, reads);
  const people = await reads.people();
  const matter = matterOfSteps(await reads.book(), [
    ...(arrival ? [arrival.unit] : []),
    ...observations,
  ]);
  return {
    addedAt: firstAt ?? null,
    allDay: a.allDay,
    appointment: id,
    endsAt: when.to,
    from: e && {
      at: e.at,
      chat: e.chat,
      message: `msg:${e.source}|${e.id}`,
      sender: people.partyOf(speakerOf(e.source, e, people.resolve)),
      text: clip(redact(messageWordsOf(e.text)), 300),
    },
    link: arrival?.link ?? null,
    matterId: matter?.id ?? null,
    pushId: pushIdOf(id),
    removedAt: last.op === "refused" ? last.at : null,
    startsAt: when.from,
    title: a.title,
    where: a.place,
  };
}
export type AppointmentSheet = NonNullable<
  Awaited<ReturnType<typeof readAppointmentSheet>>
>;
