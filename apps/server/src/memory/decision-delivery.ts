import { clock } from "../core/clock";
import { appendJsonl } from "../core/files";
import {
  DECISIONS,
  DECISIONS_VERSION,
  type Decision,
  Delivered,
} from "./decision-lines";

// The gate's verdict on an agent's card (`delivered` lines, written by bundle E's gate), read back by one rule,
// `deliveryOf`: what is held or sent back is in none of his lists (`decisionsNow`).

/**
 * Where the gate left card `d` at `now` (its latest `delivered` line): `pending` (an agent's card asked since cards
 * carry `ask`, not gated yet), `held` until `until`, `sent_back` to its agent (the gate's `note`, for its door), else
 * `delivered`, `silent` when it must never push. A card asked before the gate, his own or Life's counts as delivered. The
 * one rule: a held or sent-back card is in none of his lists or counts (`decisionsNow`); a pending one stays open there
 * until the gate's tick reads it, so the push and the gate skip it by this function.
 */
export function deliveryOf(
  d: Pick<Decision, "agent" | "ask" | "delivered">,
  now = clock()
):
  | { silent?: true; state: "delivered" }
  | { state: "held"; until: string }
  | { note?: string; state: "sent_back" }
  | { state: "pending" } {
  const l = d.delivered;
  if (!l) {
    return d.agent && d.ask ? { state: "pending" } : { state: "delivered" };
  }
  if (l.verdict === "hold" && l.until && Date.parse(l.until) > now.getTime()) {
    return { state: "held", until: l.until };
  }
  if (l.verdict === "send_back") {
    return { state: "sent_back", ...(l.note ? { note: l.note } : {}) };
  }
  return { state: "delivered", ...(l.silent ? { silent: true } : {}) };
}

/** Appends the gate's verdict on card `id` (bundle E's writer): a hold names until when. */
export function recordDelivered(
  id: string,
  verdict: Omit<Delivered, "at" | "id" | "kind" | "schemaVersion">,
  now = clock()
) {
  if (verdict.verdict === "hold" && !verdict.until) {
    throw new Error("Not done: a hold names until when.");
  }
  const line: Delivered = {
    ...verdict,
    at: now.toISOString(),
    id,
    kind: "delivered",
    schemaVersion: DECISIONS_VERSION,
  };
  appendJsonl(DECISIONS, Delivered, [line]);
  return line;
}
