import { connect, holdArchive, migrateDb } from "@lifelog/db";
import { intelligenceRuns } from "@lifelog/db/schema";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { audioStore } from "./audio-store";
import { snapshotArchive } from "./backup";
import { loadConfig } from "./config";
import { logged, refreshOwnerTimeZone, reportError } from "./diagnostics";
import { runCommand } from "./export";
import { regroupDirty } from "./grouping";
import { askForUploads, TICK_MS } from "./latency";
import { searchFor } from "./search";
import { services } from "./services";
import { loadSwitches } from "./switches";

// `lifelog-server export|import <folder>`: the archive as a folder (export.ts), and no server.
const [command] = process.argv.slice(2);
if (command === "export" || command === "import") {
  process.exit(await runCommand(process.argv.slice(2), process.env));
}

const config = loadConfig(process.env);
// Kept referenced until exit: the lock lasts as long as its connection.
const archiveLock = holdArchive(config.DATABASE_PATH);
process.on("exit", () => archiveLock.close());
const db = connect(config.DATABASE_PATH);
// A crash, thrown or a promise nobody awaited, is reported like any background failure; Host
// restarts the server.
const crashed = (error: unknown) => {
  reportError(db, "crash", error);
  process.exit(1);
};
process.on("uncaughtException", crashed);
process.on("unhandledRejection", crashed);
migrateDb(db);
refreshOwnerTimeZone(db);
loadSwitches(db);
// Nothing runs before this process: a run a restart (a deploy) cut off waits, and the next
// drain resumes it where it stopped (intelligence_calls).
db.update(intelligenceRuns)
  .set({ error: "cut off by a restart", state: "waiting" })
  .where(eq(intelligenceRuns.state, "running"))
  .run();
const s = services(config, db, {
  audio: audioStore(config),
  search: searchFor(db),
});
const {
  excerpts,
  health,
  mac,
  morning,
  nudge,
  rolling,
  search,
  voices,
  worker,
} = s;
const app = createApp(s);

// ponytail: in-process timer, assumes one replica; move to a cron service if scaled out.
// The search sweep also indexes what reconcile completed, and the backlog at startup. The
// credits are read at startup too, so a deploy knows at once whether uploads may go.
search?.index();
// The credits, what reconcile settles, then what can go.
worker
  .tick()
  .catch((error: unknown) => reportError(db, "reconcile loop", error));
// What is due to summarize, for `GET /status`, before the first tick (it rolls if the Mac is there).
rolling.drain();
let snapshotAfter = 0;
setInterval(() => {
  worker
    .tick()
    .catch((error: unknown) => reportError(db, "reconcile loop", error))
    .finally(() => search?.index());
  // The Pendant records and the phone's heard-through lags: it sends what is ready.
  askForUploads(db, nudge).catch((error: unknown) =>
    reportError(db, "upload push", error)
  );
  // A thin phone's pages not labeled or cut yet (a pass after each stored batch does most).
  s.pages.poke();
  // Sources a regroup failed to cover, then the summaries due, if the Mac is there (they also
  // start the moment the Mac wakes).
  logged(db, "regroup", () => regroupDirty(db));
  rolling.drain();
  // Once a night: match old conversations again, rebuild unnamed groups, expire voice data.
  voices.nightly();
  // Jobs whose turns were not cut yet: identity was away, or a restart cut it off.
  excerpts
    .pending()
    .catch((error: unknown) => reportError(db, "excerpts", error));
  // Once a day: the restic snapshot when it is set up (restic.ts), else the archive copied to the
  // bucket (or AUDIO_DIR) beside the phone's snapshots; tried at most hourly, so a failing
  // bucket costs one copy an hour, never two at once.
  if (Date.now() >= snapshotAfter) {
    snapshotAfter = Date.now() + 3_600_000;
    (s.restic ? s.restic.daily() : snapshotArchive(db, s.audio)).catch(
      (error: unknown) => reportError(db, "archive snapshot", error)
    );
  }
  // Once an hour: the archive's invariants, and an email to the owner when one breaks.
  health
    .hourly()
    .catch((error: unknown) => reportError(db, "archive health", error));
  // Where each conversation stands and why it waits (the Mac, credits, a switch), in the feed.
  logged(db, "conversation states", () => s.states.refresh());
  // Once a morning: yesterday's people to name, and one notification.
  morning
    .morning()
    .catch((error: unknown) => reportError(db, "people digest", error));
}, TICK_MS);

export default {
  fetch: app.fetch,
  hostname: config.LISTEN_HOST,
  // The feed holds a request up to 60 s (`wait`), and an upload from a slow phone takes a
  // while; Bun's 10 s default would cut both off.
  idleTimeout: 255,
  port: config.PORT,
  websocket: mac.websocket,
};
