import { clock, MIN } from "../core/clock";
import { log } from "../core/log";
import { DESK_AGENT } from "../core/names";
import { settings } from "../core/settings";
import { readRepoFolder } from "../host/change-registered-agent";
import {
  handedOutActive,
  handedOutSince,
  heldByAgents,
  isFull,
  readCursor,
  runtimeOf,
} from "../host/desk-read";
import { openChecksNow } from "../host/inbox";
import { isHeldOf } from "../memory/held-matters";
import { readDismissedMatterPins } from "../memory/memory-files";
import { mattersToDo } from "../memory/read-matters";
import { loadTruth } from "../memory/read-truth";
import { dayNow, dayStart, zoneNow } from "../memory/zones";
import { endAgent, hasAsked } from "./agent-actions";
import { start } from "./agent-changes";
import { type Desk, saveCursor } from "./desk-store";
import {
  HAND_OUT_BRIEF,
  handOutOf,
  isCardOverdue,
  NO_CARD_OUTCOME,
  paceRefusalOf,
} from "./hand-out";

// The hand-out's step of the desk's tick (`hand-out.ts` decides): at most one start per look, a look at most every
// `LOOK_EVERY`, each gate cheaper than the next, so a look under a cap reads no matter book.

const CURSOR = "hand_out";
const LOOK_EVERY = 10 * MIN;

/** What the pick reads, once its gates are passed: the matters to do and the steps he dismissed. */
export const readHandOutBook = async () => ({
  dismissed: readDismissedMatterPins(),
  matters: await mattersToDo(),
});

/** How many of the agents' cards he is shown now: his inbox's decisions a registered agent asked (`openChecksNow`), never one his inbox hides. */
const readCardsShown = async () =>
  (await openChecksNow()).filter(
    (c) => c.kind === "decision" && c.asker === DESK_AGENT
  ).length;

/** Starts one agent on the top matter that qualifies, when his settings allow and his pace has room; returns its id. */
export async function handOutNext(desk: Desk, read = readHandOutBook) {
  const { db } = desk;
  const pace = settings().desk?.handOut;
  const runtime = runtimeOf({});
  if (!pace) {
    return;
  }
  if (!runtime) {
    log("desk.hand_out", { why: "no default runtime" });
    return;
  }
  const last = readCursor(db, CURSOR);
  if (last && clock().getTime() - Date.parse(last) < LOOK_EVERY) {
    return;
  }
  saveCursor(db, CURSOR, clock().toISOString());
  if (isFull(db)) {
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
  const blocked = await desk.runtimes[runtime]?.block();
  if (blocked) {
    log("desk.hand_out", { why: `${runtime} does not answer: ${blocked}` });
    return;
  }
  const book = await read();
  const matter = handOutOf({ ...book, isHeld: isHeldOf(heldByAgents(db)) });
  if (!matter) {
    return;
  }
  const truth = matter.projects.length > 0 ? await loadTruth() : undefined;
  const started = start(
    desk,
    {
      action: "start",
      folder: truth && readRepoFolder(matter.projects, truth),
      runtime,
      steps: matter.steps.map((s) => s.ref),
    },
    HAND_OUT_BRIEF,
    { kind: "handed_out" }
  );
  log("desk.hand_out", { matter: matter.id, ...started });
  return started.id;
}

/**
 * Ends each handed-out agent that asked no card within `CARD_WITHIN_MS` of its first turn's beginning (`isCardOverdue`),
 * the one way an agent is ended (`endAgent`): its matter stays held until it has a newer step (`isHeldOf`), so no try of its own is counted.
 */
export async function endAgentsWithoutCard(desk: Desk) {
  const now = clock().getTime();
  for (const a of handedOutActive(desk.db)) {
    if (isCardOverdue(a, hasAsked(a.id), now)) {
      // biome-ignore lint/performance/noAwaitInLoops: one agent's decision withdrawn at a time
      await endAgent(desk, a.id, NO_CARD_OUTCOME);
    }
  }
}
