import { clock, iso } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import {
  type AssignmentRow,
  anchorsOf,
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

// Queueing an agent's events (the desk's clock, `desk-clock.ts`, polls): the one insert, which assignment of each agent an
// event wakes (`routeOf`), and the poll of the event channels a wait names.

/** Who his people are, read when a poll first needs them: once per poll (`readPeopleOnce`). */
export type ReadPeople = () => Promise<People>;

/**
 * Queues `wakes` (one event each) as `name`, each only once per agent: an event already queued for any assignment of
 * the wake's agent, consumed, dropped or closed, is never queued for another (a poll read again after a restart, or
 * after the assignment it went to closed, wakes no sibling). The one boundary every poll queues through.
 */
export function queue(
  db: Desk["db"],
  name: string,
  wakes: { assignment: string; eventId: string; payload: unknown }[]
) {
  for (const w of wakes) {
    const { changes } = db.run(
      "insert or ignore into event (assignment_id, event_id, name, payload, received_at) select ?1, ?2, ?3, ?4, ?5 where exists (select 1 from assignment where id = ?1 and closed_at is null) and not exists (select 1 from event e join assignment s on s.id = e.assignment_id where e.event_id = ?2 and s.agent_id = (select agent_id from assignment where id = ?1))",
      [
        w.assignment,
        w.eventId,
        name,
        JSON.stringify(w.payload),
        clock().toISOString(),
      ]
    );
    if (changes > 0) {
      log("desk.queued", {
        assignment: w.assignment,
        event: name,
        eventId: w.eventId,
      });
    }
  }
}

/** Why an event wakes an assignment: its wait matches, else the wide net (`matter-net.ts`) by a person or by meaning. */
export type WakeWhy =
  | { why: "wait" }
  | { why: "person" }
  | { similarity: number; why: "meaning" };

/** An assignment an event may wake, as `routeOf` ranks it: its agent, whether it is the agent's own (no anchors), when it was opened. */
export interface Holder {
  agent: string;
  isOwn: boolean;
  openedAt: string;
}

/** Each of `assignments` as `routeOf` ranks it, by its id. */
export const holdersOf = (db: Desk["db"], assignments: AssignmentRow[]) =>
  new Map<string, Holder>(
    assignments.map((s) => [
      s.id,
      {
        agent: s.agent_id,
        isOwn: anchorsOf(db, s.id).length === 0,
        openedAt: s.opened_at,
      },
    ])
  );

/** A wake's rank: a matter's wait, the agent's own wait, then the net by a person, then by meaning. */
const rankOf = (w: WakeWhy, h: Holder | undefined) => {
  if (w.why === "wait") {
    return h?.isOwn ? 1 : 0;
  }
  return w.why === "person" ? 2 : 3;
};
const similarityOf = (w: WakeWhy) => (w.why === "meaning" ? w.similarity : 0);

/**
 * Of `wakes`, one per event and agent, in their order (pure): a wait beats the wide net; among waits a matter's beats the
 * agent's own listening; among nets a person beats meaning, then the closer meaning; a tie left goes to the assignment
 * opened first. Two agents an event wakes are both woken (his ruling: overlapping listening is fine).
 */
export function routeOf<
  T extends { assignment: string; by: WakeWhy; eventId: string },
>(wakes: T[], holders: Map<string, Holder>): T[] {
  const of = (w: T) => holders.get(w.assignment);
  const picked = new Set<T>();
  const seen = new Set<string>();
  for (const w of wakes.toSorted(
    (x, y) =>
      rankOf(x.by, of(x)) - rankOf(y.by, of(y)) ||
      similarityOf(y.by) - similarityOf(x.by) ||
      (of(x)?.openedAt ?? "").localeCompare(of(y)?.openedAt ?? "")
  )) {
    const key = JSON.stringify([w.eventId, of(w)?.agent ?? w.assignment]);
    if (!seen.has(key)) {
      seen.add(key);
      picked.add(w);
    }
  }
  return wakes.filter((w) => picked.has(w));
}

/**
 * The one assignment a confirmed arrival goes to (pure): of the open
 * assignments on a matter it relates to (`related`: by a person who wrote it, or by meaning, `matter-net.ts`), a
 * person's first, then the closest meaning, then the lowest id; else the Personal agent's own (`personal`); else none.
 */
export const matterOrPersonalOf = (
  related: { assignment: string; by: WakeWhy }[],
  personal: string | undefined
) =>
  related.toSorted(
    (x, y) =>
      rankOf(x.by, undefined) - rankOf(y.by, undefined) ||
      similarityOf(y.by) - similarityOf(x.by) ||
      x.assignment.localeCompare(y.assignment)
  )[0]?.assignment ?? personal;

/**
 * Each open assignment's wakes by `events`: those its wait wants (`matcherOf`), from after it was opened (by the event's
 * instant, else by its day against the local day it was opened): nothing before is new to it; one assignment per agent
 * (`routeOf`). One already queued for the agent is refused by `queue`.
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
  const wakes = assignments.flatMap((s) => {
    const matchers = filtersOf(s).flatMap((f) => matcherOf(f, people) ?? []);
    return events.flatMap((e) =>
      isOnOrAfter(e, s.opened_at) &&
      matchers.some((isMatch) => isMatch(e.matchable))
        ? [
            {
              assignment: s.id,
              by: { why: "wait" } as WakeWhy,
              eventId: e.eventId,
              payload: e.payload,
            },
          ]
        : []
    );
  });
  return routeOf(wakes, holdersOf(db, assignments)).map(({ by, ...w }) => w);
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
  const filters = assignments.flatMap(filtersOf);
  const reads = channelReadsIn(db);
  const t = clock().getTime();
  for (const c of desk.channels ?? EVENT_CHANNELS) {
    const last = reads.get(c.name);
    const naming = filters.filter((f) => f.channels?.includes(c.name));
    if (naming.length === 0 || (last && t - last.at < c.beat)) {
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
      const events = await c.read(t, naming);
      reads.set(c.name, { at: t });
      const wakes = agentWakesOf(db, assignments, people, events);
      db.transaction(() => queue(db, c.event, wakes))();
    } catch (error) {
      const why = errorOf(error);
      failed(why.error);
      log("desk.runtime", { ...why, ok: false, what: c.name });
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
