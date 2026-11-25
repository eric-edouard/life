import { clock, MIN } from "../core/clock";
import { log } from "../core/log";
import { DESK_AGENT } from "../core/names";
import { settings } from "../core/settings";
import {
  handedOutActive,
  handedOutSince,
  heldByAgents,
  readCursor,
  standingAgents,
} from "../host/desk-read";
import { openChecksNow } from "../host/inbox";
import { decisionsNow } from "../memory/decisions";
import { isHeldOf } from "../memory/held-matters";
import {
  agentForMatterOf,
  type HandOutFacts,
  type HandOutMatter,
  readHandOutMatters,
} from "../memory/read-matters";
import { loadTruth } from "../memory/read-truth";
import { dayNow, dayStart, zoneNow } from "../memory/zones";
import { closeAssignment, hasAsked, openAssignment } from "./agent-actions";
import { type Desk, saveCursor } from "./desk-store";
import {
  handOutOf,
  isCardOverdue,
  NO_CARD_OUTCOME,
  paceRefusalOf,
} from "./hand-out";

// The hand-out's step of the desk's tick (`hand-out.ts` decides): at most one assignment per look, a look at most every
// `LOOK_EVERY`, each gate cheaper than the next, so a look under a cap reads no matter book. It starts no agent: it
// gives the matter to the agent that takes it (`agentForOf`).

const CURSOR = "hand_out";
const LOOK_EVERY = 10 * MIN;

/** What the pick reads: his ranking of running matters and the facts of the gates (`handOutGateOf`) but the hold and the agent that takes it, which are the desk's. */
interface HandOutBook {
  facts: Omit<HandOutFacts, "agentFor" | "isHeld">;
  matters: readonly HandOutMatter[];
}

/** How many of the agents' cards he is shown now: his inbox's decisions a registered agent asked (`openChecksNow`), never one his inbox hides. */
const readCardsShown = async () =>
  (await openChecksNow()).filter(
    (c) => c.kind === "decision" && c.asker === DESK_AGENT
  ).length;

/** Gives the top matter that qualifies to the agent that takes it, when his settings allow and his pace has room: an assignment the desk opened. Returns its id. */
export async function handOutNext(
  desk: Desk,
  read: () => Promise<HandOutBook> = readHandOutMatters
) {
  const { db } = desk;
  const pace = settings().desk?.handOut;
  if (!pace) {
    return;
  }
  const last = readCursor(db, CURSOR);
  if (last && clock().getTime() - Date.parse(last) < LOOK_EVERY) {
    return;
  }
  saveCursor(db, CURSOR, clock().toISOString());
  const standing = standingAgents(db);
  if (standing.length === 0) {
    return;
  }
  const startedToday = handedOutSince(
    db,
    dayStart(dayNow(), zoneNow()).toISOString()
  );
  // The day's count first: over it, his inbox is not read.
  if (
    paceRefusalOf(pace, { cardsOpen: 0, startedToday }) ||
    paceRefusalOf(pace, { cardsOpen: await readCardsShown(), startedToday })
  ) {
    return;
  }
  const { facts, matters } = await read();
  const agentFor = agentForMatterOf(standing, await loadTruth());
  const isHeld = isHeldOf(heldByAgents(db));
  const matter = handOutOf({ facts: { ...facts, agentFor, isHeld }, matters });
  const agent = matter && agentFor(matter);
  if (!agent) {
    return;
  }
  const assignment = openAssignment(desk, agent, {
    matter: matter.id,
    openedBy: "desk",
    steps: matter.steps.map((s) => s.ref),
  });
  log("desk.hand_out", { agent, assignment, matter: matter.id });
  return assignment;
}

/**
 * Closes each assignment the desk opened that neither asked a card nor waits `CARD_WITHIN_MS` after its first turn's
 * beginning (`isCardOverdue`), by `closeAssignment`: its matter stays held until it has a newer step (`isHeldOf`), so no try of
 * its own is counted.
 */
export async function endAgentsWithoutCard(desk: Desk) {
  const now = clock().getTime();
  const decisions = decisionsNow();
  for (const s of handedOutActive(desk.db)) {
    if (isCardOverdue(s, hasAsked(desk.db, s, decisions), now)) {
      // biome-ignore lint/performance/noAwaitInLoops: one card withdrawn at a time
      await closeAssignment(desk, s.id, NO_CARD_OUTCOME);
    }
  }
}
