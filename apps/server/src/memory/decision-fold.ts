import type { z } from "zod";
import { readAppended } from "../core/files";
import {
  type Asked,
  DECISIONS,
  DECISIONS_VERSION,
  type Decision,
  type DoneSeen,
  type Line,
  type SendFailed,
  Stored,
} from "./decision-lines";

// A decision as stored, read: its lines folded in order into `Decision`s (the first answer, withdrawal and end
// stand; a `not sent:` or `not_found` outcome voids the answer).

/** `d` with its answer voided by the `not sent:` or `not_found` outcome `l`: the card is open again, the answer kept in `voided`. */
export const voidedBy = (
  d: Omit<Decision, "state">,
  l: SendFailed | DoneSeen
) => {
  const outcome = l.kind === "done-seen" ? { doneSeen: l } : { notSent: l };
  return {
    ...d,
    ...outcome,
    answer: undefined,
    send: undefined,
    voided: [
      ...(d.voided ?? []),
      ...(d.answer ? [{ answer: d.answer, ...outcome }] : []),
    ],
  };
};

/** `d` with Life's look `l` read: the first `seen` stands; a `not_found` is an answer's look's outcome only, and voids it; else unchanged. */
function withDoneSeen(d: Omit<Decision, "state">, l: DoneSeen) {
  if (l.state === "seen" && d.doneSeen?.state !== "seen") {
    return { ...d, doneSeen: l };
  }
  return l.state === "not_found" && d.answer && !d.doneSeen
    ? voidedBy(d, l)
    : d;
}

/** `d` with its line `l` read: the first answer, withdrawal and end stand; a `not sent:` outcome voids the answer. */
function withLine(
  d: Omit<Decision, "state">,
  l: Exclude<z.infer<typeof Line>, Asked>
): Omit<Decision, "state"> {
  switch (l.kind) {
    case "answered":
      // A `not_found` that voided an earlier answer is no outcome of this one.
      return d.answer
        ? d
        : {
            ...d,
            answer: l,
            doneSeen: d.doneSeen?.state === "seen" ? d.doneSeen : undefined,
          };
    case "done-seen":
      return withDoneSeen(d, l);
    case "added":
      return d.added ? d : { ...d, added: l };
    case "withdrawn":
      return d.withdrawn ? d : { ...d, withdrawn: l };
    case "kept":
      return d.kept ? d : { ...d, kept: l };
    case "send-failed":
      return l.error.startsWith("not sent:")
        ? voidedBy(d, l)
        : { ...d, send: l };
    case "sent":
      return { ...d, send: l };
    default:
      return d.end ? d : { ...d, end: l };
  }
}

/** Every decision as stored, by id, in the order asked: the first answer kept, until a `not sent:` outcome voids it. */
export const readAll = () =>
  readAppended(
    DECISIONS,
    Stored,
    (last?: Map<string, Omit<Decision, "state">>) => new Map(last),
    (all, l) => {
      if (l.schemaVersion !== DECISIONS_VERSION) {
        return;
      }
      const d = all.get(l.id);
      if (l.kind === "asked") {
        all.set(l.id, l);
      } else if (d) {
        all.set(l.id, withLine(d, l));
      }
    }
  );
