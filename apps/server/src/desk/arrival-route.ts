import { clock, HOUR } from "../core/clock";
import {
  type AssignmentRow,
  anchorsOf,
  openAssignments,
} from "../host/desk-read";
import { readUnitsOf } from "../memory/memory-files";
import {
  type ConfirmedArrival,
  readConfirmedArrivals,
} from "../memory/read-replies";
import { localDate } from "../memory/zones";
import type { Unit } from "../records/unit";
import type { Desk } from "./desk-store";
import { queue, type ReadPeople } from "./event-queue";
import { netsOf } from "./matter-net";

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
 * The one assignment a confirmed arrival goes to (pure): one on a matter whose people wrote its lines (the wide net's
 * people, `netsOf`; the lowest assignment id among several), else the Personal agent's own. None: nothing. A waiting
 * agent whose wait matches the message is not here: its `message.received` came first, from the message poll's own
 * matcher over the message itself, and `pollArrivals` queues nothing for a message already queued.
 */
export function arrivalRouteOf(
  facts: ArrivalFacts,
  o: {
    netPeople: { assignment: string; people: ReadonlySet<string> }[];
    personal: string | undefined;
  }
) {
  return (
    o.netPeople
      .filter((n) => facts.people.some((p) => n.people.has(p)))
      .map((n) => n.assignment)
      .toSorted()[0] ?? o.personal
  );
}

/** The Personal agent's own open assignment (no anchors), if any: the first opened. */
const personalOf = (desk: Desk, assignments: AssignmentRow[]) => {
  const personal = new Set(
    desk.db
      .query<{ id: string }, []>("select id from agent where is_personal = 1")
      .all()
      .map((r) => r.id)
  );
  return assignments
    .filter(
      (s) => personal.has(s.agent_id) && anchorsOf(desk.db, s.id).length === 0
    )
    .toSorted((x, y) => x.opened_at.localeCompare(y.opened_at))[0]?.id;
};

/**
 * Queues `arrival.confirmed` for the confirmed arrivals of the last 12 hours, each to one assignment
 * (`arrivalRouteOf`). An arrival whose message the desk already queued for any agent (its `message.received`, a
 * `matter.related`, or this event on an earlier poll) is never queued again, so no agent is woken twice and a
 * restart, or a recipient that closed, routes nothing anew.
 */
export async function pollArrivals(
  desk: Desk,
  readPeopleNow: ReadPeople,
  o: { arrivals?: ConfirmedArrival[]; now?: Date; units?: Unit[] } = {}
) {
  const now = o.now ?? clock();
  const assignments = openAssignments(desk.db);
  if (assignments.length === 0) {
    return;
  }
  const since = new Date(now.getTime() - LOOK_BACK).toISOString();
  const arrivals = o.arrivals ?? readConfirmedArrivals(since);
  if (arrivals.length === 0) {
    return;
  }
  const people = await readPeopleNow();
  const units = new Map(
    (
      o.units ??
      readUnitsOf([
        ...new Set([localDate(since), localDate(now.toISOString())]),
      ])
    ).map((u) => [u.id, u])
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
  const personal = personalOf(desk, assignments);
  const wakes = facts.flatMap((f) => {
    const assignment =
      !queued.has(f.id) && arrivalRouteOf(f, { netPeople: nets, personal });
    return assignment ? [{ assignment, eventId: f.id, payload: f }] : [];
  });
  desk.db.transaction(() => queue(desk.db, ARRIVAL_CONFIRMED, wakes))();
}
