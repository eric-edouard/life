import { clock, daysBefore, HOUR } from "../core/clock";
import { readUnitsOf } from "../memory/memory-files";
import {
  type ConfirmedArrival,
  readConfirmedArrivals,
} from "../memory/read-replies";
import { localDate } from "../memory/zones";
import type { Unit } from "../records/unit";
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
  o: { arrivals?: ConfirmedArrival[]; now?: Date; units?: Unit[] } = {}
) {
  const now = o.now ?? clock();
  const since = new Date(now.getTime() - LOOK_BACK).toISOString();
  const arrivals = o.arrivals ?? readConfirmedArrivals(since);
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
  const nets = await netsOf(desk, people);
  const routed = facts.flatMap((f) =>
    queued.has(f.id) ? [] : [{ f, related: arrivalNetsOf(f, nets) }]
  );
  const newest = routed.reduce((a, r) => (r.f.at > a ? r.f.at : a), "");
  const blocked = routed.some((r) => r.related.length === 0)
    ? await roleStartBlockOf(desk, "personal", () => newest)
    : undefined;
  desk.db.transaction(() => {
    let place: ReturnType<typeof roleAssignmentOf> | undefined;
    const personal = () => {
      place ??= roleAssignmentOf(desk, "personal", PERSONAL_BRIEF, blocked);
      return "assignment" in place ? place.assignment : undefined;
    };
    queue(
      desk.db,
      ARRIVAL_CONFIRMED,
      routed.flatMap(({ f, related }) => {
        const assignment = matterOrPersonalOf(
          related,
          related.length > 0 ? undefined : personal()
        );
        return assignment ? [{ assignment, eventId: f.id, payload: f }] : [];
      })
    );
  })();
}
