// How fast speech becomes words and summaries: measured over the last day (`GET /status`), and
// pushed along while the Pendant records (`askForUploads`).

import type { Db } from "@life/voice-db";
import {
  chapters,
  hasRawPages,
  isPendant,
  transcriptionJobs as jobs,
  sources,
} from "@life/voice-db/schema";
import { and, eq, gt, isNotNull, max, not } from "drizzle-orm";
import type { Nudge } from "./apns";
import { latestHeartbeat, pendantRecords } from "./diagnostics";
import { switches } from "./switches";

// Median and 90th percentile of seconds, rounded, interpolated as Postgres' percentile_cont was
// (null when there are none).
export function spread(seconds: number[]) {
  const sorted = seconds.toSorted((a, b) => a - b);
  const at = (p: number) => {
    const i = (sorted.length - 1) * p;
    const lo = sorted[Math.floor(i)];
    const hi = sorted[Math.ceil(i)];
    return lo === undefined || hi === undefined
      ? null
      : Math.round(lo + (hi - lo) * (i - Math.floor(i)));
  };
  return { median: at(0.5), p90: at(0.9) };
}

const secondsBetween = (from: Date | null, to: Date | null) =>
  from && to ? [(to.getTime() - from.getTime()) / 1000] : [];

// Median and 90th percentile, in seconds, over the jobs of blocks completed since `since`:
// from the block's last speech to its upload, and from the upload to its words.
export function latency(db: Db, since: Date) {
  const rows = db
    .select({
      completedAt: jobs.completedAt,
      createdAt: jobs.createdAt,
      speechEnd: jobs.captureEnd,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.state, "completed"),
        isNotNull(jobs.pages),
        gt(jobs.completedAt, since)
      )
    )
    .all();
  return {
    jobs: rows.length,
    transcriptionSeconds: spread(
      rows.flatMap((r) => secondsBetween(r.createdAt, r.completedAt))
    ),
    uploadSeconds: spread(
      rows.flatMap((r) => secondsBetween(r.speechEnd, r.createdAt))
    ),
  };
}

// Speech to summary since `since`: from a chapter's end (where the next one starts, or the
// conversation's end) to when it was first summarized; median and 90th percentile, in seconds.
export function chapterLatency(db: Db, since: Date) {
  const rows = db
    .select({ endAt: chapters.endAt, summarizedAt: chapters.summarizedAt })
    .from(chapters)
    .where(gt(chapters.summarizedAt, since))
    .all();
  return {
    chapters: rows.length,
    seconds: spread(
      rows.flatMap((r) => secondsBetween(r.endAt, r.summarizedAt))
    ),
  };
}

// Heard-through this far behind while the Pendant records: the phone holds audio it could send.
const BEHIND_MS = 5 * 60_000;
// The server's tick (index.ts): reconcile, the sweeps and `askForUploads`.
export const TICK_MS = 5 * 60_000;

// Asks the phone for its speech (a silent push, `ready: "upload"`) while the latest heartbeat says
// the Pendant records and the Pendant's heard-through is more than 5 minutes behind. The 5-minute
// tick calls it, so at most one push every 5 minutes. Behind by more than the owner's delay
// (`openAppAfterMinutes`, Settings; 0 is off), it also asks him to open the app (`ready: "open"`, a
// visible alert), once per episode: only on the tick that first finds it past the delay.
// ponytail: a tick missed in that window (a deploy) skips that episode's alert. Before the
// handover no source has a heard-through, and nothing is asked.
export async function askForUploads(db: Db, nudge: Nudge, now = new Date()) {
  if (!pendantRecords(latestHeartbeat(db))) {
    return false;
  }
  // The iPhone's sources only: the push wakes the iPhone, and a raw-page source's heard-through
  // (the server's own) must not hide the iPhone's lag.
  const row = db
    .select({ heard: max(sources.heardThrough) })
    .from(sources)
    .where(and(isPendant, not(hasRawPages())))
    .get();
  const behind = row?.heard ? now.getTime() - row.heard.getTime() : 0;
  if (behind <= BEHIND_MS) {
    return false;
  }
  const behindSeconds = Math.round(behind / 1000);
  await nudge("upload", { behindSeconds });
  const delay = switches().openAppAfterMinutes * 60_000;
  if (delay > 0 && behind > delay && behind <= delay + TICK_MS) {
    await nudge("open", { behindSeconds });
  }
  return true;
}
