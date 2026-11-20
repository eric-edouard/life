import { clock, DAY, iso, MIN } from "../core/clock";
import { log } from "../core/log";
import { settings } from "../core/settings";
import { readRepoFolder } from "../host/change-registered-agent";
import {
  CARD_WITHIN_MS,
  handedOutActiveBefore,
  handedOutSince,
  handedOutSteps,
  heldByAgents,
  isFull,
  NO_CARD_OUTCOME,
  openTurn,
  readCursor,
  runtimeOf,
} from "../host/desk-read";
import { openChecksNow } from "../host/inbox";
import { decisionsNow } from "../memory/decisions";
import { NEW_MATTER_DAYS } from "../memory/matter-read";
import { readDismissedMatterPins } from "../memory/memory-files";
import { mattersToDo } from "../memory/read-matters";
import { loadTruth } from "../memory/read-truth";
import { dayNow, dayStart, zoneNow } from "../memory/zones";
import { finish, hasAsked, stopRun } from "./agent-actions";
import { start } from "./agent-changes";
import { type Desk, saveCursor } from "./desk-store";
import {
  HAND_OUT_BRIEF,
  handOutOf,
  isCardOverdue,
  paceRefusalOf,
} from "./hand-out";

// The hand-out's step of the desk's tick (`hand-out.ts` decides): at most one start per look, a look at most every
// `LOOK_EVERY`, each gate cheaper than the next, so a look under a cap reads no matter book.

const CURSOR = "hand_out";
const LOOK_EVERY = 10 * MIN;

/** What the pick reads, once its gates are passed: the matters to do, the steps he dismissed, the matters a "Start an agent on this?" check is open for. */
export const readHandOutBook = async () => ({
  dismissed: readDismissedMatterPins(),
  matters: await mattersToDo(),
  offered: new Set(
    (await openChecksNow())
      .filter((c) => c.kind === "new matter")
      .map((c) => c.ref)
  ),
});

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
  const cardsOpen = decisionsNow().filter(
    (d) => d.state === "open" && d.agent
  ).length;
  if (paceRefusalOf(pace, { cardsOpen, startedToday })) {
    return;
  }
  const blocked = await desk.runtimes[runtime]?.block();
  if (blocked) {
    log("desk.hand_out", { why: `${runtime} does not answer: ${blocked}` });
    return;
  }
  const book = await read();
  // A hand-out that never began holds nothing (`heldByAgents`), yet its try counts: its matter waits as an ended try's does.
  const held = new Set([
    ...heldByAgents(db).steps,
    ...handedOutSteps(db, iso(clock().getTime() - NEW_MATTER_DAYS * DAY)),
  ]);
  const matter = handOutOf({ ...book, held });
  if (!matter) {
    return;
  }
  const truth = matter.projects.length > 0 ? await loadTruth() : undefined;
  const started = db.transaction(() => {
    const r = start(
      desk,
      {
        action: "start",
        folder: truth && readRepoFolder(matter.projects, truth),
        runtime,
        steps: matter.steps,
      },
      HAND_OUT_BRIEF
    );
    if (r.id) {
      db.run("update agent set is_handed_out = 1 where id = ?", [r.id]);
    }
    return r;
  })();
  log("desk.hand_out", { matter: matter.id, ...started });
  return started.id;
}

/**
 * Ends each handed-out agent that asked no card within `CARD_WITHIN_MS` of its creation, as `finish` ends one, and stops
 * its run: its matter stays held 7 days (`heldByAgents`), so no try of its own is counted.
 */
export async function endAgentsWithoutCard(desk: Desk) {
  const { db } = desk;
  const now = clock().getTime();
  for (const a of handedOutActiveBefore(db, iso(now - CARD_WITHIN_MS))) {
    if (
      !isCardOverdue(a, { begun: a.begun === 1, hasAsked: hasAsked(a.id) }, now)
    ) {
      continue;
    }
    const open = openTurn(db, a.id);
    // biome-ignore lint/performance/noAwaitInLoops: one agent's decision withdrawn at a time
    await finish(desk, a.id, NO_CARD_OUTCOME);
    if (open?.session) {
      await stopRun(desk.runtimes[a.runtime], a.id, open.session);
    }
  }
}
