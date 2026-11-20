import { clock, MIN } from "../core/clock";
import { log } from "../core/log";
import { settings } from "../core/settings";
import { readRepoFolder } from "../host/change-registered-agent";
import {
  handedOutSince,
  heldByAgents,
  isFull,
  readCursor,
  runtimeOf,
} from "../host/desk-read";
import { openChecksNow } from "../host/inbox";
import { decisionsNow } from "../memory/decisions";
import { readDismissedMatterPins } from "../memory/memory-files";
import { mattersToDo } from "../memory/read-matters";
import { loadTruth } from "../memory/read-truth";
import { zoneNow } from "../memory/zones";
import { start } from "./agent-changes";
import { type Desk, saveCursor } from "./desk-store";
import {
  HAND_OUT_BRIEF,
  handOutDayStartOf,
  handOutOf,
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
  if (!(pace && runtime)) {
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
    handOutDayStartOf(clock(), zoneNow()).toISOString()
  );
  const cardsOpen = decisionsNow().filter(
    (d) => d.state === "open" && d.agent
  ).length;
  if (paceRefusalOf(pace, { cardsOpen, startedToday })) {
    return;
  }
  const blocked = await desk.runtimes[runtime]?.block();
  if (blocked) {
    return;
  }
  const book = await read();
  const matter = handOutOf({ ...book, held: new Set(heldByAgents(db).steps) });
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
