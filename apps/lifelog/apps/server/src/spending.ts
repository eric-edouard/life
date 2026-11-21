import type { Db } from "@lifelog/db";
import { intelligenceRuns, transcriptionJobs } from "@lifelog/db/schema";
import { voiceNoteHearings } from "@lifelog/db/schema/voice-note-hearings";
import {
  and,
  count,
  gte,
  inArray,
  isNotNull,
  lt,
  ne,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";

// What Voice spent between two instants, for Life's model spending (`GET /spending`): read from its three ledgers,
// each by its indexed instant. A job counts once settled: `billed` (done; its Scribe seconds, 0 for a speech job's own
// work) or `maybe_billed` (a send it may have been billed for and was never told: never counted as billed); a job
// queued or sent (its seconds an estimate) and a model run under way or waiting to start again are only counted,
// `unsettled`, so the day waits for them; a job that failed with nothing billed is left out.

const UNSETTLED = ["queued", "submitted"] as const;
/** A settled job's outcome: a whole Scribe job that completed was billed; a speech job's routed send, or a failed job, that may have been billed is apart. */
const outcomeOf = (j: { maybeBilled: boolean; transcriber: string }) =>
  j.maybeBilled && j.transcriber === "speech"
    ? ("maybe_billed" as const)
    : ("billed" as const);
const settledOutcomeOf = (j: {
  maybeBilled: boolean;
  state: string;
  transcriber: string;
}) => (j.state === "failed" ? ("maybe_billed" as const) : outcomeOf(j));

const PENDING_RUNS = ["running", "waiting"] as const;
const MAC_PROVIDERS = ["claude-code", "codex"] as const;

export function spendingOf(db: Db, from: Date, to: Date) {
  const countIn = (
    table: typeof transcriptionJobs | typeof intelligenceRuns,
    at: typeof transcriptionJobs.admittedAt | typeof intelligenceRuns.createdAt,
    where: SQL
  ) =>
    db
      .select({ n: count() })
      .from(table)
      .where(and(gte(at, from), lt(at, to), where))
      .get()?.n ?? 0;
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
        notInArray(transcriptionJobs.state, UNSETTLED),
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
        // Settled, and on his plans through the Mac (the paid APIs' runs are older, and none runs now).
        notInArray(intelligenceRuns.state, PENDING_RUNS),
        inArray(intelligenceRuns.provider, MAC_PROVIDERS)
      )
    )
    .all();
  const unsettled =
    countIn(
      transcriptionJobs,
      transcriptionJobs.admittedAt,
      inArray(transcriptionJobs.state, UNSETTLED)
    ) +
    countIn(
      intelligenceRuns,
      intelligenceRuns.createdAt,
      and(
        inArray(intelligenceRuns.state, PENDING_RUNS),
        inArray(intelligenceRuns.provider, MAC_PROVIDERS)
      ) as SQL
    );
  return {
    jobs: jobs.map((j) => ({
      at: j.admittedAt.toISOString(),
      billableSeconds: j.billableSeconds,
      outcome: settledOutcomeOf(j),
      seconds: j.seconds,
      transcriber: j.transcriber,
    })),
    modelRuns: runs.map((r) => ({ ...r, at: r.at.toISOString() })),
    unsettled,
    // A note whose answer was lost has no seconds: it may have been billed.
    voiceNotes: notes.map((n) => ({
      at: n.doneAt?.toISOString() ?? "",
      billableSeconds: n.billableSeconds,
      route: n.route,
      seconds: n.seconds,
    })),
  };
}
