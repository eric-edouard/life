import { clock } from "../core/clock";
import { redact } from "../core/redact";
import type { SourceEvent } from "../records/source";
import { pushIdOf } from "../sources/lifelog-push";
import { readAppointmentEvents, readAppointments } from "./appointments";
import { readArrivalAppointments } from "./arrival-appointments";
import { span } from "./episode-span";
import { matterOfSteps } from "./matter-read";
import type { readMatterBook } from "./matters";
import { readIndex } from "./memory-files";
import { messageWordsOf } from "./message-files";
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

/** The message an appointment was read from: the arrival's one holding its quote (else its newest), the night's first fact's. */
function sourceMessageOf(
  a: { messages: string[]; quote: string } | { observations: string[] },
  reads: AppointmentReads
) {
  if ("messages" in a) {
    const events = a.messages.toReversed().map(reads.message);
    const quoted = events.find((e) =>
      e ? messageWordsOf(e.text).includes(a.quote) : false
    );
    return quoted ?? events.find(Boolean) ?? null;
  }
  const first = readIndex((db) =>
    db
      .query<{ channel: string; ref: string }, [string]>(
        "select channel, ref from observations where id = ?"
      )
      .get(a.observations[0] ?? "")
  );
  return first ? reads.message(`${first.channel}|${first.ref}`) : null;
}

/** The appointment `q` names (its id, or its push's id), as the sheet shows it; null when Life holds none. */
export async function readAppointmentSheet(
  q: { appointment?: string; pushId?: string },
  reads: AppointmentReads,
  now = clock()
) {
  const night = readAppointments()?.appointments ?? [];
  const a = [...night, ...readArrivalAppointments(now)].find(
    (x) => x.id === q.appointment || pushIdOf(x.id) === q.pushId
  );
  if (!a) {
    return null;
  }
  const { byAppointment, created } = readAppointmentEvents();
  const last = byAppointment.get(a.id);
  const when = span(
    { day: a.start.slice(0, 10), end: a.end, start: a.start },
    a.zone ?? undefined
  );
  const e = sourceMessageOf(a, reads);
  const people = await reads.people();
  const matter = matterOfSteps(
    await reads.book(),
    "messages" in a ? [a.unit] : a.observations
  );
  return {
    addedAt: created.get(a.id) ?? null,
    allDay: a.allDay,
    appointment: a.id,
    endsAt: when.to,
    from: e && {
      at: e.at,
      chat: `${e.source}|${e.chat}`,
      message: `msg:${e.source}|${e.id}`,
      sender: people.partyOf(speakerOf(e.source, e, people.resolve)),
      text: clip(redact(messageWordsOf(e.text)), 300),
    },
    link: "link" in a ? a.link : null,
    matterId: matter?.id ?? null,
    pushId: pushIdOf(a.id),
    removedAt: last?.op === "refused" ? last.at : null,
    startsAt: when.from,
    title: a.title,
    where: a.place,
  };
}
export type AppointmentSheet = NonNullable<
  Awaited<ReturnType<typeof readAppointmentSheet>>
>;
