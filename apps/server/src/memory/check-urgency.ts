import type { CheckGroup } from "./life-checks";

/** `blocks`: a worker waits on him, or Life cannot answer at all; `improves`: Life already uses its guess, or only asks. */
export type Urgency = "blocks" | "improves";

interface Rankable {
  group: CheckGroup;
  likelyPeople: unknown[];
}

/**
 * Where a check stands in his inbox, first to last: an agent's decision, a voice nobody has named, a name with no
 * person or an ambiguous Contacts card (these block); then a new matter's offer, a guess in use (a guessed person, a
 * voice with a likely person), and last "is this done?". The one rule of the inbox's order and of what blocks.
 */
export const inboxRankOf = (c: Rankable) => {
  switch (c.group) {
    case "decision":
      return 0;
    case "voice":
      return c.likelyPeople.length > 0 ? 4 : 1;
    case "name":
    case "contacts card":
      return 2;
    case "new matter":
      return 3;
    case "guessed person":
      return 4;
    default:
      return 5;
  }
};

const LAST_BLOCKING_RANK = 2;
export const urgencyOf = (c: Rankable): Urgency =>
  inboxRankOf(c) <= LAST_BLOCKING_RANK ? "blocks" : "improves";

/** How many of `list` block him: the app's badge, and the one place to change what it counts. */
export const blockingOf = (list: Rankable[]) =>
  list.filter((c) => urgencyOf(c) === "blocks").length;
