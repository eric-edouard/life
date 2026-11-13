import { statSync } from "node:fs";
import { clock } from "../../core/clock";
import { systemZone } from "../../core/platform";
import { INDEX } from "../../memory/memory-files";
import { lockedSince } from "../../memory/memory-lock";
import { latestRuns, PROCESSING_RUNS, type Run } from "../../memory/run-log";
import {
  MAX_ATTEMPTS,
  nextNight,
  readBackfill,
  readState,
} from "../../memory/schedule";
import { keptStores, listening } from "../../memory/sources";
import { localDate } from "../../memory/zones";
import { lastCopied } from "../archive";
import { polling, readHealth } from "../health";

// Life's status, for the status snapshot, the connector and `bun life memory status`: whether it works, how fresh its memory is
// and what runs next, from the runs (memory/run-log.ts), the archive's copies and the watcher's health.

/** Each archive store's last copy (`lastCopied`), by store name. */
const copiedByStore = (): Record<string, string | null> =>
  Object.fromEntries(keptStores().map((s) => [s.name, lastCopied(s)]));
/** When a SQLite file last changed, its write-ahead log included (written before the file); null: no file. */
function dbTime(path: string) {
  const ms = Math.max(
    ...[path, `${path}-wal`].map(
      (p) => statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0
    )
  );
  return ms ? new Date(ms).toISOString() : null;
}
/** How far back `read_life_status` looks in derived/log for the last runs of each kind. */
const STATUS_DAYS = 7;
/** The latest run of a step, and the latest that succeeded and failed, within what `read_life_status` read. */
function lastOf(list: Run[], step: string) {
  const mine = list.filter((r) => r.step === step);
  return {
    lastFailed: mine.find((r) => r.outcome === "failed") ?? null,
    lastOk: mine.find((r) => r.outcome === "ok") ?? null,
    latest: mine[0] ?? null,
  };
}
/**
 * Is Life working, how fresh is its memory, and what runs next. Four clocks, kept apart: capture (the watcher folds
 * lifelog in as it arrives; the archive copies chats), extraction (nightly, backfill weeks), consolidation
 * (pages: nightly) and the index (rebuilt by the watcher on any lifelog change and by every processing run: a new index is not new memory).
 * A missing record is "unknown", never healthy.
 */
export async function lifeStatus(now = clock()) {
  const health = readHealth();
  const lock = lockedSince();
  const night = readState();
  const list = await latestRuns(STATUS_DAYS, lock);
  const running = list.filter((r) => r.outcome === "running");
  let watcher: Record<string, unknown> = { state: "unknown" };
  if (!listening()) {
    watcher = { state: "off" };
  } else if (health) {
    watcher = {
      ...health,
      state: polling(health, now.getTime()) ? "ok" : "not-polling",
    };
  }
  return {
    backfill: {
      ...lastOf(list, "memory.backfill"),
      state: readBackfill() ?? null,
    },
    capture: {
      archive: copiedByStore(),
      // The key keeps its name for the status reads' contract: the verdicts are the episodes step's since 18 Oct.
      lastTriage: lastOf(list, "memory.episodes").latest?.result ?? null,
      lifelogOkAt: health?.lastOkAt ?? null,
    },
    consolidation: lastOf(list, "memory.pages"),
    extraction: lastOf(list, "memory.extract"),
    indexBuiltAt: dbTime(INDEX),
    lookbackDays: STATUS_DAYS,
    nightly: {
      ...lastOf(list, "memory.nightly"),
      maxAttempts: MAX_ATTEMPTS,
      next: nextNight(now, localDate(now.toISOString()), night),
      state: night ?? "unknown",
    },
    observedAt: now.toISOString(),
    processing: lock
      ? {
          // The phase the processing run last entered (`phases`, run.ts), else the step running (runs from before 21 Oct).
          phase:
            running.find((r) => PROCESSING_RUNS.has(r.step))?.phases?.at(-1) ??
            running.find((r) => !PROCESSING_RUNS.has(r.step))?.step ??
            null,
          since: lock.toISOString(),
          state: "running",
          sweep: running.find((r) => PROCESSING_RUNS.has(r.step))?.id ?? null,
        }
      : { state: "idle" },
    // Read now: the long-running server's own zone can be the one it started in.
    timeZone: systemZone(),
    watcher,
  };
}
