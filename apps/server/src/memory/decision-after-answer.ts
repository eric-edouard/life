import { clock } from "../core/clock";
import { appendJsonl } from "../core/files";
import { log } from "../core/log";
import { readAll } from "./decision-fold";
import {
  AnswerWithdrawn,
  DECISIONS,
  DECISIONS_VERSION,
  type Decision,
  type MARKS,
  Rated,
} from "./decision-lines";

// His lines on a card after his answer: his Undo of it (`answer-withdrawn`, `withdrawAnswer`) and his mark on how Life
// did ("How am I doing?", `rated`). Append-only, one synchronous line each, like the answer.

/** Appends his mark on card `id` ("How am I doing?"), once it is answered. */
export function rateDecision(
  id: string,
  mark: (typeof MARKS)[number],
  now = clock()
) {
  const d = readAll().get(id);
  if (!d?.answer) {
    throw new Error(`Not done: ${id} is not answered.`);
  }
  const line = {
    at: now.toISOString(),
    id,
    kind: "rated" as const,
    mark,
    schemaVersion: DECISIONS_VERSION,
  };
  appendJsonl(DECISIONS, Rated, [line]);
  return line;
}

/**
 * His Undo of his answer to card `id`: an `answer-withdrawn` line voids it and the card is open again. Refused once
 * what it did can't be taken back here: an outcome line (an end, an event added, a run, a look), or a send unless Life
 * deleted that message first (`unsent`, its id). Host refuses it too once the asker's turn took the answer.
 */
export function withdrawAnswer(id: string, unsent?: string, now = clock()) {
  const d = readAll().get(id);
  if (!d?.answer) {
    throw new Error(`Not done: ${id} has no answer to undo.`);
  }
  const done = d.end ?? d.added ?? d.ran ?? d.doneSeen;
  if (done) {
    throw new Error(
      `Not done: his answer already ${done.kind === "done-seen" ? "had Life look for the step" : `${done.kind} (${done.at})`}.`
    );
  }
  if (d.send && !(d.send.kind === "sent" && d.send.eventId === unsent)) {
    throw new Error(
      "Not done: his answer sent the draft; only deleting that message undoes it."
    );
  }
  const line: AnswerWithdrawn = {
    at: now.toISOString(),
    id,
    kind: "answer-withdrawn",
    schemaVersion: DECISIONS_VERSION,
    ...(unsent ? { unsent } : {}),
  };
  appendJsonl(DECISIONS, AnswerWithdrawn, [line]);
  log("decision.answered", { id, undone: true, unsent: Boolean(unsent) });
  return line;
}

/** What his last answer's failed send left, for the app: when, why, and whether another tap could work (not when the card's deadline passed before it ended); null when nothing is left. */
export const notSentOf = (d: Decision, n = d.notSent) =>
  n
    ? {
        at: n.at,
        canRetry: n.canRetry !== false && n.at < d.deadline,
        reason: n.error,
        wrote: n.wrote ?? null,
      }
    : null;
