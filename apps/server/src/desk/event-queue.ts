import { clock, iso } from "../core/clock";
import { log } from "../core/log";
import {
  type AssignmentRow,
  eventHeard,
  filtersOf,
  openAssignments,
} from "../host/desk-read";
import {
  EVENT_CHANNELS,
  isOnOrAfter,
  type Matchable,
} from "../host/event-channels";
import { matcherOf } from "../host/events";
import type { People } from "../memory/who";
import type { Desk } from "./desk-store";

// Queueing an agent's events (the desk's clock, `desk-clock.ts`, polls): the one insert, which agents an event wakes,
// and the poll of the event channels a wait names.

/** Who his people are, read when a poll first needs them: once per poll (`readPeopleOnce`). */
export type ReadPeople = () => Promise<People>;

/** Queues `wakes` (one event each, kept once per assignment and id) as `name`. */
export function queue(
  db: Desk["db"],
  name: string,
  wakes: { assignment: string; eventId: string; payload: unknown }[]
) {
  for (const w of wakes) {
    db.run(
      "insert or ignore into event (assignment_id, event_id, name, payload, received_at) values (?, ?, ?, ?, ?)",
      [
        w.assignment,
        w.eventId,
        name,
        JSON.stringify(w.payload),
        clock().toISOString(),
      ]
    );
  }
}

/**
 * Each open assignment's wakes by `events`: those its wait wants (`matcherOf`), from after it was opened (by the event's
 * instant, else by its day against the local day it was opened): nothing before is new to it; not queued for it yet
 * (`eventHeard`).
 */
export function agentWakesOf<T>(
  db: Desk["db"],
  assignments: AssignmentRow[],
  people: People,
  events: {
    at?: string;
    day?: string;
    eventId: string;
    matchable: Matchable;
    payload: T;
  }[]
) {
  return assignments.flatMap((s) => {
    const matchers = filtersOf(s).flatMap((f) => matcherOf(f, people) ?? []);
    return events.flatMap((e) =>
      isOnOrAfter(e, s.opened_at) &&
      matchers.some((isMatch) => isMatch(e.matchable)) &&
      eventHeard(db, s.id, e.eventId) === "not_yet"
        ? [{ assignment: s.id, eventId: e.eventId, payload: e.payload }]
        : []
    );
  });
}

/** Each event channel's last read, and since when it has failed and why, in this process (never stored). */
const channelReads = new WeakMap<
  Desk["db"],
  Map<string, { at: number; failedSince?: string; why?: string }>
>();
function channelReadsIn(db: Desk["db"]) {
  const reads = channelReads.get(db) ?? new Map();
  channelReads.set(db, reads);
  return reads;
}

/**
 * Reads each event channel some open assignment's wait names, when its beat is due, and queues its events for every
 * assignment whose wait wants one (`agentWakesOf`: once per assignment and event, the queue the dedupe). A channel no wait names is never
 * read; one that is off (its `block`) is not read, and one that is off or fails queues nothing, stalls nothing, and is said
 * in the next wakes (`unreadLinesOf`).
 */
export async function pollChannels(desk: Desk, readPeopleNow: ReadPeople) {
  const { db } = desk;
  const assignments = openAssignments(db);
  const named = new Set(
    assignments.flatMap((s) => filtersOf(s).flatMap((f) => f.channels ?? []))
  );
  const reads = channelReadsIn(db);
  const t = clock().getTime();
  for (const c of desk.channels ?? EVENT_CHANNELS) {
    const last = reads.get(c.name);
    if (!named.has(c.name) || (last && t - last.at < c.beat)) {
      continue;
    }
    const failed = (why: string) =>
      reads.set(c.name, {
        at: t,
        failedSince: last?.failedSince ?? iso(t),
        why,
      });
    const blocked = c.block();
    if (blocked) {
      failed(blocked);
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one channel at a time, each read bounded by its own timeout
    const people = await readPeopleNow();
    try {
      const events = await c.read(t);
      reads.set(c.name, { at: t });
      const wakes = agentWakesOf(db, assignments, people, events);
      db.transaction(() => queue(db, c.event, wakes))();
    } catch (error) {
      const why = (error as Error).message;
      failed(why);
      log("desk.runtime", { error: why, ok: false, what: c.name });
    }
  }
}

/** The lines a wake of assignment `s` carries for each channel its wait names that cannot be read now: since when, and why. */
export const unreadLinesOf = (
  db: Desk["db"],
  s: Pick<AssignmentRow, "wait_events">
) => {
  const reads = channelReadsIn(db);
  return [...new Set(filtersOf(s).flatMap((f) => f.channels ?? []))].flatMap(
    (name) => {
      const r = reads.get(name);
      return r?.failedSince
        ? [`${name} could not be read since ${r.failedSince}: ${r.why}`]
        : [];
    }
  );
};
