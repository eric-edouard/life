import { digest } from "../core/hash";
import { LIFE_ASKER } from "../core/names";
import { complaintOf } from "../records/ledger-entry";
import type { BeingFixed, Check } from "./life-checks";
import { askOf } from "./memory-files";

// What his complaints (his words through Tell Life, `host/complaints.ts`) need of the checks: the cause a card rests on,
// and which cards the caretaker is at work on (`checks.ts` attaches them).

/**
 * What a card of Life's rests on, as a digest: its kind, what it acts on, its subject, its question (the guess, in
 * words), a new matter's goal, the words it rests on (`quote`, also quoted in its context) and its `basis` (what else
 * its builder says it rests on: an ending's later step); never its labels, rank or counts. His complaint names it; another guess, goal or link at the
 * same ref is another cause.
 */
export const causeOf = (
  c: Pick<Check, "group" | "question" | "ref" | "subject"> & {
    goal?: string | null;
  },
  basis?: string,
  quote?: string
) =>
  digest(
    "sha256",
    JSON.stringify([
      c.group,
      c.ref,
      c.subject,
      c.question,
      c.goal ?? null,
      quote ?? null,
      basis ?? null,
    ]),
    16
  );

/** Card `c` with its "Wrong…" (`misread`) and his complaint at work on its cause (`beingFixed`): on Life's own cards alone, never an agent's (the caretaker's included). */
export function withComplaintFields<
  C extends Pick<
    Check,
    "asker" | "goal" | "group" | "question" | "ref" | "subject"
  >,
>(
  c: C,
  fixing?: ReadonlyMap<string, BeingFixed>,
  basis?: string,
  quote?: string
) {
  const cause = c.asker === LIFE_ASKER ? causeOf(c, basis, quote) : null;
  return {
    ...c,
    beingFixed: (cause && fixing?.get(cause)) || undefined,
    misread: cause ? { cause } : null,
  };
}

/** His complaints the caretaker is at work on (host's `complaintsAtWork`), by the cause each names (`CheckInputs.fixing`): for a cause named twice, the first received. */
export function fixingOf(atWork: readonly BeingFixed[]) {
  const fixing = new Map<string, BeingFixed>();
  for (const w of atWork) {
    const a = askOf(w.ask);
    const cause = a && complaintOf(a)?.cause;
    if (cause && !fixing.has(cause)) {
      fixing.set(cause, w);
    }
  }
  return fixing;
}
