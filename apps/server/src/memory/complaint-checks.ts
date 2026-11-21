import { createHmac } from "node:crypto";
import { digest } from "../core/hash";
import { LIFE_ASKER } from "../core/names";
import { same, secretIn } from "../core/secret";
import { complaintOf } from "../records/ledger-entry";
import type { BeingFixed, Check } from "./life-checks";
import { askOf } from "./memory-files";

// What his complaints (his "Wrong…" on a card of Life's, `host/complaints.ts`) need of the checks: the cause a card
// rests on, the card as shown and its seal, and which cards the caretaker is at work on (`checks.ts` attaches them).

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

/** What seals a card's "Wrong…" as Life showed it: its ref, cause and card as shown, under a key that never leaves the Mac. */
const sealOf = (ref: string, cause: string, shown: string, key: string) =>
  createHmac("sha256", key)
    .update(JSON.stringify(["misread", ref, cause, shown]))
    .digest("hex")
    .slice(0, 32);

/** What his press sends back of a card: its cause, the card as shown (a digest) and their seal (`Check.misread`). */
export interface MisreadShown {
  cause: string;
  seal: string;
  shown: string;
}

/** Whether `m` is a "Wrong…" Life showed on card `ref` (its seal holds): a card of Life's, as it was then, whether or not it is still open. */
export const isSealed = (
  ref: string,
  m: MisreadShown,
  key = secretIn("pushIdKey")
) => same(m.seal, sealOf(ref, m.cause, m.shown, key));

/**
 * The inbox's cards with their "Wrong…" sealed as finally shown (network identity, push id and urgency attached): the
 * digest of each card but its own `misread`, and the seal of its ref, cause and that digest. A nested confirm takes its
 * twin's, the same card at the top.
 */
export function withMisreadSealed<
  C extends {
    confirm: { misread?: unknown; ref: string }[];
    misread?: { cause: string } | null;
    ref: string;
  },
>(list: C[], key: string) {
  const sealed = list.map(({ misread, ...card }) => {
    const shown = digest("sha256", JSON.stringify(card), 16);
    return {
      ...card,
      misread: misread
        ? {
            cause: misread.cause,
            seal: sealOf(card.ref, misread.cause, shown, key),
            shown,
          }
        : null,
    };
  });
  const byRef = new Map(sealed.map((c) => [c.ref, c.misread]));
  return sealed.map((c) => ({
    ...c,
    confirm: c.confirm.map((x) => ({
      ...x,
      misread: byRef.get(x.ref) ?? null,
    })),
  }));
}

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
