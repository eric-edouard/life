import { clock } from "../core/clock";
import { appendJsonl } from "../core/files";
import { log } from "../core/log";
import { OWNER_ASKER } from "../core/names";
import { readAll } from "./decision-fold";
import {
  AnswerWithdrawn,
  DECISIONS,
  DECISIONS_VERSION,
  type Decision,
  type MARKS,
  Rated,
} from "./decision-lines";
import { actDueOf, actOutcomeOf } from "./decisions";
import { isBatchOf } from "./draft";
import { localDate } from "./zones";

/**
 * The cards "How am I doing?" asks about, with his mark so far (null: none): sampled by code, at most one a day, the first
 * agent's card he answered in Life's app that local day (`via` connector: the app open, so a free moment), never one the
 * gate read as sensitive (`silent`). Worked out from the decisions; nothing is stored, so dismiss and silence write nothing.
 */
export function rateOffersOf(
  all: readonly Pick<
    Decision,
    "answer" | "asker" | "at" | "delivered" | "id" | "rated"
  >[]
) {
  const offers = new Map<string, Decision["rated"]>();
  const days = new Set<string>();
  const answered = all
    .filter(
      (d) =>
        d.answer?.via === "connector" &&
        d.asker !== OWNER_ASKER &&
        !d.delivered?.silent
    )
    .toSorted((a, b) => (a.answer?.at ?? "").localeCompare(b.answer?.at ?? ""));
  for (const d of answered) {
    const day = localDate(d.answer?.at ?? d.at);
    if (!days.has(day)) {
      days.add(day);
      offers.set(d.id, d.rated);
    }
  }
  return offers;
}

// His lines on a card after his answer: his Undo of it (`answer-withdrawn`, `withdrawAnswer`) and his mark on how Life
// did ("How am I doing?", `rated`). Append-only, one synchronous line each, like the answer.

/** Appends his mark on card `id` ("How am I doing?"), once it is answered and offered (`rateOffersOf`). */
export function rateDecision(
  id: string,
  mark: (typeof MARKS)[number],
  now = clock()
) {
  const d = readAll().get(id);
  if (!d?.answer) {
    throw new Error(`Not done: ${id} is not answered.`);
  }
  if (!rateOffersOf([...readAll().values()]).has(id)) {
    throw new Error(`Not done: Life did not ask how it did on ${id}.`);
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
  const act = actDueOf(d);
  if (act && !actOutcomeOf(d, act)) {
    throw new Error(
      `Not done: the ${act} his answer started is still running.`
    );
  }
  const done = d.end ?? d.added ?? d.ran ?? d.doneSeen;
  if (done) {
    throw new Error(
      `Not done: his answer already ${done.kind === "done-seen" ? "had Life look for the step" : `${done.kind} (${done.at})`}.`
    );
  }
  // Only a one-draft card's sent message, deleted, is undone: a batch's sends are never.
  const [send] = d.sends;
  if (
    send &&
    (isBatchOf(d) || !(send.kind === "sent" && send.eventId === unsent))
  ) {
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
