import type { Db } from "@lifelog/db";
import { intelligenceRuns, transcriptionJobs } from "@lifelog/db/schema";
import { voiceNoteHearings } from "@lifelog/db/schema/voice-note-hearings";
import { and, gte, isNotNull, lt, ne, notInArray, or } from "drizzle-orm";

// What Voice spent between two instants, for Life's model spending (`GET /spending`): read from its three ledgers,
// each by its indexed instant. A job counts once settled: `billed` (done; its Scribe seconds, 0 for a speech job's own
// work), `maybe_billed` (a send it may have been billed for and was never told: never counted as billed), `unsettled`
// (queued or sent, its seconds an estimate); a job that failed with nothing billed is left out.

const outcomeOf = (j: { maybeBilled: boolean; state: string }) => {
  if (j.maybeBilled) {
    return "maybe_billed" as const;
  }
  return j.state === "completed" ? ("billed" as const) : ("unsettled" as const);
};

export function spendingOf(db: Db, from: Date, to: Date) {
  const jobs = db
    .select({
      admittedAt: transcriptionJobs.admittedAt,
      billableSeconds: transcriptionJobs.billableSeconds,
      maybeBilled: transcriptionJobs.maybeBilled,
      seconds: transcriptionJobs.preparedDurationSeconds,
      state: transcriptionJobs.state,
      transcriber: transcriptionJobs.transcriber,
    })
    .from(transcriptionJobs)
    .where(
      and(
        gte(transcriptionJobs.admittedAt, from),
        lt(transcriptionJobs.admittedAt, to),
        or(ne(transcriptionJobs.state, "failed"), transcriptionJobs.maybeBilled)
      )
    )
    .all();
  const notes = db
    .select({
      billableSeconds: voiceNoteHearings.billableSeconds,
      doneAt: voiceNoteHearings.doneAt,
      route: voiceNoteHearings.route,
      seconds: voiceNoteHearings.seconds,
    })
    .from(voiceNoteHearings)
    .where(
      and(
        isNotNull(voiceNoteHearings.doneAt),
        gte(voiceNoteHearings.doneAt, from),
        lt(voiceNoteHearings.doneAt, to)
      )
    )
    .all();
  const runs = db
    .select({
      at: intelligenceRuns.createdAt,
      inputTokens: intelligenceRuns.inputTokens,
      latencyMs: intelligenceRuns.latencyMs,
      model: intelligenceRuns.model,
      outputTokens: intelligenceRuns.outputTokens,
      provider: intelligenceRuns.provider,
    })
    .from(intelligenceRuns)
    .where(
      and(
        gte(intelligenceRuns.createdAt, from),
        lt(intelligenceRuns.createdAt, to),
        // Settled: a run still under way, or waiting to start again in place, has no tokens yet.
        notInArray(intelligenceRuns.state, ["running", "waiting"])
      )
    )
    .all();
  return {
    jobs: jobs.map((j) => ({
      at: j.admittedAt.toISOString(),
      billableSeconds: j.billableSeconds,
      outcome: outcomeOf(j),
      seconds: j.seconds,
      transcriber: j.transcriber,
    })),
    modelRuns: runs.map((r) => ({ ...r, at: r.at.toISOString() })),
    // A note whose answer was lost has no seconds: it may have been billed.
    voiceNotes: notes.map((n) => ({
      at: n.doneAt?.toISOString() ?? "",
      billableSeconds: n.billableSeconds,
      route: n.route,
      seconds: n.seconds,
    })),
  };
}
