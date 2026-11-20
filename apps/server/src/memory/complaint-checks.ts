import { digest } from "../core/hash";
import { LIFE_ASKER } from "../core/names";
import { complaintOf } from "../records/ledger-entry";
import type { BeingFixed, Check } from "./life-checks";
import { askOf } from "./memory-files";

// What his complaints (his "Wrong…" on a card of Life's, `host/complaints.ts`) need of the checks: the cause a card
// rests on, the card as built, and which cards the caretaker is at work on (`checks.ts` attaches them).

/**
 * What a card of Life's rests on, as a digest: its kind, what it acts on, its subject, its question (the guess, in
 * words) and the words it rests on; never its labels, rank or counts. His complaint names it; another guess or another
 * link at the same ref is another cause.
 */
export const causeOf = (
  c: Pick<Check, "evidence" | "group" | "question" | "ref" | "subject">
) =>
  digest(
    "sha256",
    JSON.stringify([
      c.group,
      c.ref,
      c.subject,
      c.question,
      c.evidence?.quote ?? null,
    ]),
    16
  );

/** A card as built, as a digest (`Check.misread.shown`): his press sends it back, so Life knows the card it reads then is the one he saw. */
const shownOf = (c: object) => digest("sha256", JSON.stringify(c), 16);

/** A card's "Wrong…" (`misread`) and his complaint at work on its cause (`beingFixed`): on Life's own cards alone, never an agent's (the caretaker's included). */
export function complaintFieldsOf(
  c: Pick<
    Check,
    "asker" | "evidence" | "group" | "question" | "ref" | "subject"
  >,
  fixing?: ReadonlyMap<string, BeingFixed>
) {
  const cause = c.asker === LIFE_ASKER ? causeOf(c) : null;
  return {
    beingFixed: (cause && fixing?.get(cause)) || undefined,
    misread: cause ? { cause, shown: shownOf(c) } : null,
  };
}

/** His complaints the caretaker is at work on, as the desk reads them (host's `complaintsAtWork`): each one's ask id, when it was received, and its line. */
export type ComplaintsAtWork = readonly {
  ask: string;
  line: string | null;
  since: string;
}[];

/** His complaints at work by the cause each names (`CheckInputs.fixing`): for a cause named twice, the first received. */
export function fixingOf(atWork: ComplaintsAtWork) {
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
