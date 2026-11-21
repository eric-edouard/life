import { clock, daysBefore, HOUR } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { wroteSince } from "../memory/draft-send";
import { readUnitsOf } from "../memory/memory-files";
import {
  type ConfirmedArrival,
  readConfirmedArrivals,
} from "../memory/read-replies";
import { localDate } from "../memory/zones";
import type { SourceEvent } from "../records/source";
import type { Unit } from "../records/unit";
import type { Descriptor } from "../sources/contract";
import type { Desk } from "./desk-store";
import { matterOrPersonalOf, queue, type ReadPeople } from "./event-queue";
import { netsOf } from "./matter-net";
import {
  PERSONAL_BRIEF,
  roleAssignmentOf,
  roleStartBlockOf,
} from "./role-agents";

// A confirmed arrival's one wake (his yes of 20 Nov 2026): the arrival reader's confirmed answer (never Apple's alone)
// chooses one agent, decided here once, beside the hand-out. The wake holds the event's facts, never its words.

/** The event a confirmed arrival queues. */
export const ARRIVAL_CONFIRMED = "arrival.confirmed";
/** How far back each poll looks: a confirm older than this has had its wake, or its day's night reads it. */
const LOOK_BACK = 12 * HOUR;

/** An arrival's facts: the desk's id of its newest message, where, who, and when it was confirmed. */
export interface ArrivalFacts {
  at: string;
  chat: string;
  id: string;
  people: string[];
  source: Unit["source"];
}

/** The facts of `arrival` from its unit, or nothing when the unit is gone (a re-cut day). */
export function arrivalFactsOf(
  arrival: ConfirmedArrival,
  unit: Unit | undefined,
  refOf: (ref: string) => string
): ArrivalFacts | undefined {
  const newest = arrival.messages.at(-1);
  if (!(unit && newest)) {
    return;
  }
  return {
    at: arrival.at,
    chat: unit.key,
    // The stored key is `source|id`; the desk names a message by its id, as `message.received` does.
    id: newest.slice(newest.indexOf("|") + 1),
    // Never `map(refOf)`: map's index would land in `refOf`'s second argument (where a name was read) and crash.
    people: arrival.people.map((p) => refOf(p)),
    source: unit.source,
  };
}

/**
 * Whether he answered an arrival: he wrote in its chat after its newest line, another person's (`events`: what was
 * written there since before it, oldest first), so no agent wakes. His own newest line is a commitment, never answered
 * by his next one. Unseen newest line (older than the read): after the confirm. A mail arrival always wakes
 * (`wroteSince` reads chats); the gate's rule covers a mail thread-day.
 */
export function hasAnsweredOf(
  events: Pick<SourceEvent, "at" | "fromMe" | "id">[],
  f: Pick<ArrivalFacts, "at" | "id">
) {
  const newest = events.find((e) => e.id === f.id);
  if (newest?.fromMe) {
    return false;
  }
  const after = newest?.at ?? f.at;
  return events.some((e) => e.fromMe && e.at > after);
}

/**
 * What was written in each arrival's chat from an hour before its confirm (its lines were read minutes before it), or
 * nothing when a source can't be read now: the arrival then wakes as before.
 */
function answersOf(facts: ArrivalFacts[], sources?: Descriptor[]) {
  try {
    return wroteSince(
      facts.map((f) => ({
        draft: { channel: f.source, chat: f.chat },
        since: new Date(Date.parse(f.at) - HOUR),
      })),
      ...(sources ? [sources] : [])
    );
  } catch (error) {
    log("desk.arrivals", { ...errorOf(error), ok: false });
    return [];
  }
}

/** Of `nets`, the ones whose people wrote an arrival's lines, as `matterOrPersonalOf` ranks them. */
export const arrivalNetsOf = (
  facts: Pick<ArrivalFacts, "people">,
  nets: { assignment: string; people: ReadonlySet<string> }[]
) =>
  nets
    .filter((n) => facts.people.some((p) => n.people.has(p)))
    .map((n) => ({ assignment: n.assignment, by: { why: "person" as const } }));

/**
 * Queues `arrival.confirmed` for the confirmed arrivals of the last 12 hours, each to one assignment
 * (`matterOrPersonalOf`: a matter's whose people wrote its lines, else the Personal agent's own, the desk registering
 * the Personal agent when none stands, `roleAssignmentOf`). An arrival whose message the desk already queued for any
 * agent (its `message.received`, a `matter.related`, or this event on an earlier poll) is never queued again, so no
 * agent is woken twice and a restart, or a recipient that closed, routes nothing anew; one with nowhere to go now (the
 * Personal agent stopped, or none can be started) is tried again at the next poll.
 */
export async function pollArrivals(
  desk: Desk,
  readPeopleNow: ReadPeople,
  o: {
    arrivals?: ConfirmedArrival[];
    now?: Date;
    /** The chat sources read for his answers (default: the enabled ones). */
    sources?: Descriptor[];
    units?: Unit[];
  } = {}
) {
  const now = o.now ?? clock();
  const since = new Date(now.getTime() - LOOK_BACK).toISOString();
  // A low-priority one is kept for the night alone: it wakes no one.
  const arrivals = (o.arrivals ?? readConfirmedArrivals(since)).filter(
    (a) => a.wakes
  );
  if (arrivals.length === 0) {
    return;
  }
  const people = await readPeopleNow();
  // A confirm since `since` (made that day or the next) reads a unit of its day or the day before (yesterday's voice).
  const first = localDate(since);
  const days = [
    daysBefore(first, 2),
    daysBefore(first, 1),
    first,
    localDate(now.toISOString()),
  ];
  const units = new Map(
    (o.units ?? readUnitsOf([...new Set(days)])).map((u) => [u.id, u])
  );
  const facts = arrivals.flatMap(
    (a) => arrivalFactsOf(a, units.get(a.unit), people.refOf) ?? []
  );
  const queued = new Set(
    desk.db
      .query<{ event_id: string }, string[]>(
        `select distinct event_id from event where event_id in (${facts.map(() => "?").join(",")})`
      )
      .all(...facts.map((f) => f.id))
      .map((r) => r.event_id)
  );
  const unqueued = facts.filter((f) => !queued.has(f.id));
  if (unqueued.length === 0) {
    return;
  }
  // ponytail: an answered arrival is never queued, so its source is read again on each poll, from an hour before its
  // confirm, until it leaves the 12-hour look-back; store answered ids if that read shows up.
  const wrote = answersOf(unqueued, o.sources);
  const nets = await netsOf(desk, people);
  const routed = unqueued.flatMap((f, i) =>
    hasAnsweredOf(wrote[i] ?? [], f)
      ? []
      : [{ f, related: arrivalNetsOf(f, nets) }]
  );
  const toMatters = routed.filter((r) => r.related.length > 0);
  const toPersonal = routed.filter((r) => r.related.length === 0);
  // A matter's arrivals first, alone: `queue` skips an assignment that closed meanwhile, left for the next poll.
  desk.db.transaction(() =>
    queue(
      desk.db,
      ARRIVAL_CONFIRMED,
      toMatters.flatMap(({ f, related }) => {
        const assignment = matterOrPersonalOf(related, undefined);
        return assignment ? [{ assignment, eventId: f.id, payload: f }] : [];
      })
    )
  )();
  if (toPersonal.length === 0) {
    return;
  }
  const newest = toPersonal.reduce((a, r) => (r.f.at > a ? r.f.at : a), "");
  const blocked = await roleStartBlockOf(desk, "personal", () => newest);
  try {
    desk.db.transaction(() => {
      const place = roleAssignmentOf(desk, "personal", PERSONAL_BRIEF, blocked);
      if ("assignment" in place) {
        queue(
          desk.db,
          ARRIVAL_CONFIRMED,
          toPersonal.map(({ f }) => ({
            assignment: place.assignment,
            eventId: f.id,
            payload: f,
          }))
        );
      }
    })();
  } catch (error) {
    // Registering the Personal agent failed (its home not made): its arrivals wait for the next poll.
    log("desk.arrivals", { ...errorOf(error), ok: false });
  }
}
