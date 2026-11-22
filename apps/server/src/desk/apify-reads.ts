import { readRun } from "../apify/backend";
import type { AssignmentRow } from "../host/desk-read";
import { decisionsNow } from "../memory/decisions";
import { cardsOf } from "./agent-actions";
import type { Desk } from "./desk-store";

// The door's Apify read (his word of 22 Nov 2026), free: a run his yes started on one of the agent's own cards. No door tool starts a run: only his pick of a card's `runs` option does
// (`runApifyByHisWord`), so his credits are never spent without him.

/** The run his answer to `card` started, as Apify holds it now: its status, what it cost so far, its first items. Only a card of the agent's own. */
export async function readApifyRun(
  { db }: Desk,
  s: Pick<AssignmentRow, "agent_id">,
  card: string
) {
  const d = cardsOf(db, s, decisionsNow()).find((x) => x.id === card);
  if (!d) {
    throw new Error(`Not done: ${card} is no card of yours.`);
  }
  if (!d.ran?.runId) {
    throw new Error(
      `Not done: ${card} started no run${d.ran?.error ? `: ${d.ran.error}` : " (he has not picked its `runs` option)"}.`
    );
  }
  return { runId: d.ran.runId, ...(await readRun(d.ran.runId)) };
}
