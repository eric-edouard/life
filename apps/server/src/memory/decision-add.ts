import { clock } from "../core/clock";
import type { Decision } from "./decision-lines";
import { type Added, DECISIONS_VERSION } from "./decision-lines";

// The calendar write of a decision's `adds` option (his word of 21 Nov 2026): the host's writer, its limit and the
// `added` line `decisions.ts` stores, once, never retried.

/** Writes the event of the decision `d` into his calendar (host: `addEventByHisWord`): the event's id; throws when it could not. */
export type AddEventByHisWord = (d: Omit<Decision, "state">) => Promise<string>;

/** The most an add may take: one calendar write through `gog`. */
export const ADD_LIMIT_MS = 60_000;

/** Writes `d`'s event with `add` and returns the `added` line: the event's id, or the error. */
export const addedLineOf = async (
  d: Pick<Decision, "id">,
  add: () => Promise<string>
): Promise<Added> => ({
  at: clock().toISOString(),
  id: d.id,
  kind: "added",
  schemaVersion: DECISIONS_VERSION,
  ...(await add().then(
    (eventId) => ({ eventId }),
    (e: Error) => ({ error: e.message })
  )),
});

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
