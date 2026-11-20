// How a job's send changes once it was read: queued again, failed, sent again or settled, only while it
// is still that send (jobs.ts and reconcile read it, then change it here).
import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import { transcriptionJobs as jobs } from "@lifelog/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { logChange } from "./change-log";

// One send of a job: the row as it was read, `requestSentAt` set when it left: to the speech
// service at its claim, to Scribe at its POST. A queued job picked for Scribe is one not sent yet.
type Send = Pick<
  typeof jobs.$inferSelect,
  "attempts" | "id" | "requestSentAt" | "state"
>;

// The one way a picked or submitted job changes: only while it is still the send that was read, so
// a stale reader (a reconcile that read before a retry, a late webhook) never moves a newer
// send; the feed hears of it. False when the job had moved on. Only a queued job picked for Scribe
// is matched as queued: every other change needs it still submitted, so a settled job never reopens.
export function onSend(
  db: Db,
  send: Send,
  set: SQLiteUpdateSetSource<typeof jobs>
) {
  return db.transaction((tx) => {
    const moved = tx
      .update(jobs)
      .set(set)
      .where(
        and(
          eq(jobs.id, send.id),
          eq(jobs.state, send.state === "queued" ? "queued" : "submitted"),
          send.requestSentAt
            ? eq(jobs.requestSentAt, send.requestSentAt)
            : isNull(jobs.requestSentAt)
        )
      )
      .returning({ id: jobs.id })
      .get();
    if (moved) {
      logChange(tx, "job", send.id);
    }
    return Boolean(moved);
  });
}

// Not sent after all (ElevenLabs busy, the bucket unreachable): queued again, not an attempt.
const BUSY_RETRY_MINUTES = 1;
export const back = (db: Db, send: Send, error: string | null) =>
  onSend(db, send, {
    error,
    nextAttemptAt: new Date(clock().getTime() + BUSY_RETRY_MINUTES * 60_000),
    requestSentAt: null,
    state: "queued",
  });

// Never sent again: ElevenLabs refused this audio, the bucket lost it, a send that may have been
// billed was never answered or reported failed, or every attempt failed. Its pages stay with the
// job (`holderOf`), so nothing buys them again.
export const fail = (db: Db, send: Send, error: string) =>
  onSend(db, send, { error, state: "failed" });

// A send that surely bought nothing (lost by ElevenLabs, a failure it reported) goes again, from
// the bucket, after 1 then 2 minutes; the third such failure fails it, so a failure that repeats
// never loops. Its provider ids are cleared, so nothing about the earlier send is taken for the next
// one's.
export const MAX_ATTEMPTS = 3;
export function retry(db: Db, send: Send, error: string) {
  const attempts = send.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    return onSend(db, send, {
      attempts,
      error: `${error} (${attempts} attempts: not sent again)`,
      state: "failed",
    })
      ? ("failed" as const)
      : null;
  }
  return onSend(db, send, {
    attempts,
    error,
    nextAttemptAt: new Date(clock().getTime() + 2 ** send.attempts * 60_000),
    providerRequestId: null,
    providerTranscriptionId: null,
    requestSentAt: null,
    state: "queued",
  })
    ? ("retried" as const)
    : null;
}
