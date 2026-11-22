import type { Decision } from "./decision-lines";
import { type Added, DECISIONS_VERSION, type Ran } from "./decision-lines";

// The calendar write of a decision's `adds` option (his word of 21 Nov 2026): the host's writer, its limit and the
// `added` line `decisions.ts` stores, once, never retried.

/** Writes the event of the decision `d` into his calendar (host: `addEventByHisWord`): the event's id; throws when it could not. */
export type AddEventByHisWord = (d: Omit<Decision, "state">) => Promise<string>;

/** The most an add may take: one calendar write through `gog`. */
export const ADD_LIMIT_MS = 60_000;

/** The line for an add that never ended (a crash): the calendar may hold the event, so it is never retried. */
export const addNeverEndedOf = (
  d: Pick<Decision, "id">,
  at: string
): Added => ({
  at,
  error:
    "may not have been added: the write started and never ended: look in his calendar before asking again",
  id: d.id,
  kind: "added",
  schemaVersion: DECISIONS_VERSION,
});

// The same for a `runs` option (his word of 22 Nov 2026): the card's Apify run, started once, never retried.

/** Starts the run of the decision `d`'s `apify` need on his Apify account (host: `runApifyByHisWord`): the run's id; throws when it could not. */
export type RunApifyByHisWord = (d: Omit<Decision, "state">) => Promise<string>;

/** The most a start may take: Apify's actor read, then the run's start (it never waits for the run). */
export const RUN_LIMIT_MS = 60_000;

/** The line for a start that never ended (a crash): Apify may hold the run, so it is never retried. */
export const ranNeverEndedOf = (d: Pick<Decision, "id">, at: string): Ran => ({
  at,
  error:
    "may have started: the start never ended: look in his Apify console before asking again",
  id: d.id,
  kind: "ran",
  schemaVersion: DECISIONS_VERSION,
});
