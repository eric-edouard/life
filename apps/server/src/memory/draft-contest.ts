import { MIN } from "../core/clock";
import { DESK_AGENT } from "../core/names";
import {
  DECISIONS_VERSION,
  type Decision,
  type Withdrawn,
  withdrawnOf,
} from "./decision-lines";
import type { StoredDraft } from "./draft";

// A draft's contest (his yes of 21 Nov 2026: Life introduces the agents). A card whose draft goes into a chat another
// asker's open card holds (the held card) waits on it (`contests`, stamped when asked): the holder yields (withdraws
// its own), merges (`merges`: one card for both) or keeps (a `kept` line); silent `CONTEST_WAIT`, the waiting card is
// asked, `replaces` the held card, and his Send withdraws that one (`answerDecision`). Pure: `decisions.ts` reads and
// writes the lines, and works out each card's contest here.

/** How long a card waits on the card holding its draft's chat before Life asks it anyway, replacing that one. */
export const CONTEST_WAIT = 10 * MIN;

type Asker = Pick<Decision, "agent" | "asker">;

/** Whether `d` is still to be settled: open, or waiting on another card. */
export const isPending = (d: Pick<Decision, "state">) =>
  d.state === "open" || d.state === "waiting";

/** Whether `a` and `b` were asked by the same asker: every registered agent asks as `desk`, its own `agent` tells them apart. */
const isSameAsker = (a: Asker, b: Asker) =>
  a.asker === b.asker && a.agent === b.agent;

/** Whether `a`'s and `b`'s drafts go into the same chat (a chat key: a mail or a new 1:1 chat has none). */
export const isSameChat = (
  a: Pick<Decision, "draft">,
  b: Pick<Decision, "draft">
) =>
  Boolean(a.draft?.chat) &&
  a.draft?.channel === b.draft?.channel &&
  a.draft?.chat === b.draft?.chat;

/**
 * Card `d`, open by its own lines, as its contest leaves it: withdrawn when the holder's card `merger` merges it; else
 * open once the held card `held` settled (a send his answer started, `isSending`, is not settled); else waiting while
 * the holder keeps, or for `CONTEST_WAIT`; then open, replacing the held card.
 */
export function contestOf(
  d: Decision,
  held: Decision | undefined,
  merger: Decision | undefined,
  isSending: boolean,
  now: Date
): Decision {
  if (merger) {
    const withdrawn: Withdrawn = {
      at: merger.at,
      id: d.id,
      kind: "withdrawn",
      replacedBy: merger.id,
      schemaVersion: DECISIONS_VERSION,
      why: `merged into ${merger.id}`,
    };
    return { ...d, state: "withdrawn", withdrawn };
  }
  if (!(held && (held.state === "open" || isSending))) {
    return d;
  }
  return d.kept || isSending || now.getTime() < Date.parse(d.at) + CONTEST_WAIT
    ? { ...d, state: "waiting" }
    : { ...d, replaces: held.id };
}

/**
 * One open draft per chat, among `list`: the newest card of another asker holding `draft`'s chat (pending, or its send
 * running: `isSending`), which a new card of `asker`'s contests (it waits on it), if any. Throws when `asker`'s own card
 * holds the chat, or a card already waits on it. The cards a merge settles (`merging`) are out of the way.
 */
export function heldChatOf(
  list: Decision[],
  draft: StoredDraft | undefined,
  asker: Asker,
  merging: string[],
  isSending: (d: Decision) => boolean
) {
  const same = list.filter(
    (d) =>
      (isPending(d) || isSending(d)) &&
      !merging.includes(d.id) &&
      isSameChat(d, { draft })
  );
  const blocking =
    same.find((d) => d.state === "waiting") ??
    same.find((d) => isSameAsker(d, asker));
  if (blocking) {
    throw new Error(
      `Not done: ${blocking.id} already ${blocking.state === "waiting" ? "waits to ask" : "asks"} a draft into ${draft?.to}; wait until it is answered or withdrawn, then read the chat again.`
    );
  }
  return same.at(-1)?.id;
}

/** The card `id`, waiting on an open card of `asker`'s, with that card (a keep's or a merge's); throws when there is none. */
export function waitingOnOf(list: Decision[], id: string, asker: Asker) {
  const waiting = list.find((d) => d.id === id && d.state === "waiting");
  const held = waiting && list.find((d) => d.id === waiting.contests);
  // The desk checks its agents' cards at its door (an assignment's, folds included): its agents ask as `desk`.
  const isHolder =
    held &&
    (asker.asker === DESK_AGENT
      ? held.asker === DESK_AGENT
      : isSameAsker(held, asker));
  if (!(waiting && isHolder && held?.state === "open")) {
    throw new Error(`Not done: ${id} is no card waiting on one of yours.`);
  }
  return { held, waiting };
}

/** The withdrawal of the holder's own card `merged.held` that a merge (card `id`) writes with it; none without a merge. */
export const mergeWithdrawalsOf = (
  merged: { held: Decision; waiting: Decision } | undefined,
  id: string,
  now: Date
): Withdrawn[] =>
  merged
    ? [
        withdrawnOf(
          merged.held.id,
          now,
          `merged with ${merged.waiting.id} into ${id}`
        ),
      ]
    : [];

/** What `request_decision` tells the asker of a card that waits on the held card `on`: until when, and why. */
export const waitsOf = (
  on: string | undefined,
  draft: StoredDraft | undefined,
  now: Date
) =>
  on
    ? {
        waits: {
          on,
          until: new Date(now.getTime() + CONTEST_WAIT).toISOString(),
          why: `${on}, another asker's card, holds a draft into ${draft?.to}: yours waits until its agent yields, merges or keeps, at most until \`until\`; then it is asked, replacing that card, and his Send withdraws it.`,
        },
      }
    : {};
