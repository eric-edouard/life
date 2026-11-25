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
import { monthBudgetOf } from "../host/spending";
import { deliveryOf } from "../memory/decision-delivery";
import { decisionsNow } from "../memory/decisions";
import { isHeldOf } from "../memory/held-matters";
import { intentionsNow } from "../memory/instructions";
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

/** How many of the agents' cards wait for him: his inbox's decisions a registered agent asked (`openChecksNow`), and those the gate holds for a better moment (`deliveryOf`), which his inbox hides. */
const readCardsShown = async () =>
  (await openChecksNow()).filter(
    (c) => c.kind === "decision" && c.asker === DESK_AGENT
  ).length +
  decisionsNow().filter(
    (d) => d.asker === DESK_AGENT && deliveryOf(d).state === "held"
  ).length;

/** Each assignment ever anchored on a standing intention (an instruction's id), and whether it is open. */
const intentionAssignmentsOf = (db: Desk["db"]) =>
  db
    .query<{ closed_at: string | null; id: string; step: string }, []>(
      "select s.id, s.closed_at, n.step from anchor n join assignment s on s.id = n.assignment_id where n.step like 'ins\\_%' escape '\\'"
    )
    .all();

/**
 * His standing intentions (`intention` instructions in force): each opens one assignment, once, anchored on it, on the
 * agent `agentForOf` names (a project's scope: its agent when it has a repo; else the Personal agent), his words its
 * own; one whose intention ended (replaced, past `until`) is closed. Not paced: they are his words, not Life's pick.
 * Never opened again once closed: an assignment is never retried.
 */
export async function openIntentions(desk: Desk) {
  const { db } = desk;
  const live = intentionsNow();
  const held = intentionAssignmentsOf(db);
  const liveIds = new Set(live.map((i) => i.id));
  for (const s of held) {
    if (s.closed_at === null && !liveIds.has(s.step)) {
      // biome-ignore lint/performance/noAwaitInLoops: one close at a time
      await closeAssignment(desk, s.id, "its intention ended");
    }
  }
  const asked = new Set(held.map((s) => s.step));
  const due = live.filter((i) => !asked.has(i.id));
  const standing = due.length > 0 ? standingAgents(db) : [];
  if (standing.length === 0) {
    return;
  }
  const agentFor = agentForMatterOf(standing, await loadTruth());
  for (const i of due) {
    const project = i.scope.startsWith("project:") ? i.scope.slice(8) : null;
    const agent = agentFor({ projects: project ? [project] : [] });
    if (agent) {
      const assignment = openAssignment(desk, agent, {
        openedBy: "owner",
        said: i.said,
        steps: [i.id],
      });
      log("desk.intention", { agent, assignment, intention: i.id });
    }
  }
}

/** Gives the top matter that qualifies to the agent that takes it, when his settings allow and his pace has room: an assignment the desk opened. Returns its id. */
export async function handOutNext(
  desk: Desk,
  read: () => Promise<HandOutBook> = readHandOutMatters
) {
  const { db } = desk;
  const pace = settings().desk?.handOut;
  // Past the month's amount, Life starts no new work by itself (`monthBudgetOf`).
  if (!pace || monthBudgetOf()?.isPassed) {
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
