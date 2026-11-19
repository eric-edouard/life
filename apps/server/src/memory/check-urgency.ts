import type { CheckGroup } from "./life-checks";

/** `blocks`: a worker waits on him, or Life cannot answer at all; `improves`: Life already uses its guess, or only asks. */
export type Urgency = "blocks" | "improves";

interface Rankable {
  group: CheckGroup;
  /** A voice's: the person lifelog suggests ("Is this voice X?"); null: none. `likelyPeople` ranks every profile, so it says nothing. */
  subject: string | null;
}

/**
 * Where a check stands in his inbox, first to last: an agent's decision, a voice nobody has named, a name with no
 * person or an ambiguous Contacts card (these block); then a new matter's offer, a guess in use (a guessed person, a
 * voice with a likely person), and last "is this done?". The one rule of the inbox's order and of what blocks.
 */
const RANK: Record<CheckGroup, number> = {
  "contacts card": 2,
  decision: 0,
  ending: 5,
  "guessed person": 4,
  name: 2,
  "new matter": 3,
  voice: 1,
};
/** A voice with a suggested person is a guess in use, like a guessed person. */
export const inboxRankOf = (c: Rankable) =>
  c.group === "voice" && c.subject !== null ? 4 : RANK[c.group];

const LAST_BLOCKING_RANK = 2;
export const urgencyOf = (c: Rankable): Urgency =>
  inboxRankOf(c) <= LAST_BLOCKING_RANK ? "blocks" : "improves";

/** How many of `list` block him: the app's badge, and the one place to change what it counts. */
export const blockingCountOf = (list: Rankable[]) =>
  list.filter((c) => urgencyOf(c) === "blocks").length;
