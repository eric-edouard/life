import { clock, iso } from "../core/clock";
import { log } from "../core/log";
import {
  type AgentRow,
  activeAgents,
  eventHeard,
  filtersOf,
} from "../host/desk-read";
import { EVENT_CHANNELS, type Matchable } from "../host/event-channels";
import { matcherOf } from "../host/events";
import type { People } from "../memory/who";
import { localDate } from "../memory/zones";
import type { Desk } from "./desk-store";

// Queueing an agent's events (the desk's clock, `desk-clock.ts`, polls): the one insert, which agents an event wakes,
// and the poll of the event channels a wait names.

/** Who his people are, read when a poll first needs them: once per poll (`readPeopleOnce`). */
export type ReadPeople = () => Promise<People>;

/** Queues `wakes` (one event each, kept once per agent and id) as `name`. */
export function queue(
  db: Desk["db"],
  name: string,
  wakes: { agent: string; eventId: string; payload: unknown }[]
) {
  for (const w of wakes) {
    db.run(
      "insert or ignore into event (agent_id, event_id, name, payload, received_at) values (?, ?, ?, ?, ?)",
      [
        w.agent,
        w.eventId,
        name,
        JSON.stringify(w.payload),
        clock().toISOString(),
      ]
    );
  }
}

/**
 * Each active agent's wakes by `events`: those its wait wants (`matcherOf`), from after it was created (by the event's
 * instant, else by its day against the agent's local day), not queued for it yet (`eventHeard`).
 */
export function agentWakesOf<T>(
  db: Desk["db"],
  agents: AgentRow[],
  people: People,
  events: {
    at?: string;
    day?: string;
    eventId: string;
    matchable: Matchable;
    payload: T;
  }[]
) {
  return agents.flatMap((a) => {
    const matchers = filtersOf(a).flatMap((f) => matcherOf(f, people) ?? []);
    return events.flatMap((e) =>
      (e.at
        ? e.at >= a.created_at
        : (e.day ?? "") >= localDate(a.created_at)) &&
      matchers.some((isMatch) => isMatch(e.matchable)) &&
      eventHeard(db, a.id, e.eventId) === "not_yet"
        ? [{ agent: a.id, eventId: e.eventId, payload: e.payload }]
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
 * Reads each event channel some active agent's wait names, when its beat is due, and queues its events for every agent
 * whose wait wants one (`agentWakesOf`: once per agent and event, the queue the dedupe). A channel no wait names is never
 * read; one that is off (its `block`) is not read, and one that is off or fails queues nothing, stalls nothing, and is said
 * in the next wakes (`unreadLinesOf`).
 */
export async function pollChannels(desk: Desk, readPeopleNow: ReadPeople) {
  const { db } = desk;
  const agents = activeAgents(db);
  const named = new Set(
    agents.flatMap((a) => filtersOf(a).flatMap((f) => f.channels ?? []))
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
      const wakes = agentWakesOf(db, agents, people, events);
      db.transaction(() => queue(db, c.event, wakes))();
    } catch (error) {
      const why = (error as Error).message;
      failed(why);
      log("desk.runtime", { error: why, ok: false, what: c.name });
    }
  }
}

/** The lines a wake of `a` carries for each channel its wait names that cannot be read now: since when, and why. */
export const unreadLinesOf = (db: Desk["db"], a: AgentRow) => {
  const reads = channelReadsIn(db);
  return [...new Set(filtersOf(a).flatMap((f) => f.channels ?? []))].flatMap(
    (name) => {
      const r = reads.get(name);
      return r?.failedSince
        ? [`${name} could not be read since ${r.failedSince}: ${r.why}`]
        : [];
    }
  );
};
