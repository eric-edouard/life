import type { z } from "zod";
import { readAppended } from "../core/files";
import {
  type AnswerWithdrawn,
  type Asked,
  DECISIONS,
  DECISIONS_VERSION,
  type Decision,
  type DoneSeen,
  type Ended,
  type Line,
  type SendFailed,
  Stored,
} from "./decision-lines";
import { draftsOf } from "./draft";

// A decision as stored, read: its lines folded in order into `Decision`s (the first answer, withdrawal and end
// stand; a `not sent:` of every draft, or a `not_found`, voids the answer; an old or one-draft `asked` line reads as
// `drafts` of one).

/** `d` with its answer voided by the `not sent:` or `not_found` outcome `l`, or his Undo: the card is open again, the answer kept in `voided`. */
export const voidedBy = (
  d: Omit<Decision, "state">,
  l: SendFailed | DoneSeen | AnswerWithdrawn
) => {
  const outcomes = {
    "answer-withdrawn": undefined,
    "done-seen": { doneSeen: l as DoneSeen },
    "send-failed": { notSent: l as SendFailed },
  };
  const outcome = outcomes[l.kind];
  return {
    ...d,
    ...outcome,
    answer: undefined,
    sends: [],
    voided: [
      ...(d.voided ?? []),
      ...(d.answer
        ? [
            {
              answer: d.answer,
              ...(outcome ?? { sends: d.sends, undone: l as AnswerWithdrawn }),
            },
          ]
        : []),
    ],
  };
};

/** Draft `i`'s send outcome among `sends` (`draftIndex`, absent for the first), if it has one. */
export const sendOf = (sends: Decision["sends"], i: number) =>
  sends.find((s) => (s.draftIndex ?? 0) === i);

/** Whether every draft of `d` has its send outcome (one line each, `draftIndex`): its send ended. */
export const isSendEndedOf = (d: Pick<Decision, "drafts" | "sends">) =>
  d.drafts.every((_, i) => sendOf(d.sends, i));

/** Whether nothing of `d`'s send went: every draft ended `not sent:`. Then his answer is voided and the card open again; once any draft went, or may have, it stays answered and nothing is sent twice (the owner's decision of 28 Nov 2026). */
const isNothingSentOf = (d: Pick<Decision, "drafts" | "sends">) =>
  isSendEndedOf(d) &&
  d.sends.every(
    (s) => s.kind === "send-failed" && s.error.startsWith("not sent:")
  );

/** `d` with Life's look `l` read: the first `seen` stands; a `not_found` is an answer's look's outcome only, and voids it; else unchanged. */
function withDoneSeen(d: Omit<Decision, "state">, l: DoneSeen) {
  if (l.state === "seen" && d.doneSeen?.state !== "seen") {
    return { ...d, doneSeen: l };
  }
  return l.state === "not_found" && d.answer && !d.doneSeen
    ? voidedBy(d, l)
    : d;
}

/** The lines kept whole on the decision, by their field. */
const FIELD_OF = {
  added: "added",
  delivered: "delivered",
  kept: "kept",
  ran: "ran",
  rated: "rated",
  withdrawn: "withdrawn",
} as const;
const LATEST = new Set(["delivered", "rated"]);

/** `d` with its line `l` read: the first answer, withdrawal and end stand; a `not sent:` outcome voids the answer. */
function withLine(
  d: Omit<Decision, "state">,
  l: Exclude<z.infer<typeof Line>, Asked>
): Omit<Decision, "state"> {
  const field = FIELD_OF[l.kind as keyof typeof FIELD_OF];
  if (field) {
    // The gate's verdict and his mark: the latest stands; any other: the first.
    return LATEST.has(l.kind) || !d[field] ? { ...d, [field]: l } : d;
  }
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
    case "send-failed":
    case "sent": {
      const sent = { ...d, sends: [...d.sends, l] };
      return isNothingSentOf(sent) ? voidedBy(sent, l as SendFailed) : sent;
    }
    case "answer-withdrawn":
      return d.answer ? voidedBy(d, l) : d;
    default:
      // Only `ended` is left: the lines kept by their field went above.
      return d.end ? d : { ...d, end: l as Ended };
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
        const { draft: _one, drafts: _batch, ...asked } = l;
        all.set(l.id, { ...asked, drafts: draftsOf(l), sends: [] });
      } else if (d) {
        all.set(l.id, withLine(d, l));
      }
    }
  );
