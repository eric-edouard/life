// How capture and processing are doing, for the owner's own sessions (`GET /status`): the archive's
// invariants, the Pendant and phone as last reported, the Mac, the pipeline, the backup,
// ElevenLabs, and the problems and chain steps of the last day; its cheap part alone for the Mac
// host's poll (`GET /status/live`). Spending stays on the phone's route.
import { z } from "@hono/zod-openapi";
import type { Db } from "@lifelog/db";
import {
  conversations,
  diagnostics,
  intelligenceRuns,
  macWatch,
} from "@lifelog/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { archiveHealth } from "./archive-health";
import { backupStatus } from "./backup";
import { summaryWait, summaryWaits } from "./conversation-state";
import {
  Heartbeat,
  HeartbeatUpload,
  latestHeartbeat,
  pendantRecording,
} from "./diagnostics";
import { lastSteps } from "./events";
import type { ExcerptSampler } from "./excerpts";
import type { JobWorker } from "./jobs";
import { chapterLatency, latency } from "./latency";
import type { MacSocket } from "./mac-socket";
import { macView } from "./quiet-ranges";
import type { Restic } from "./restic";
import type { Rolling } from "./rolling";
import { latestValid } from "./summaries";
import { switches } from "./switches";

const DAY_MS = 24 * 3600 * 1000;

interface Parts {
  excerpts: ExcerptSampler;
  mac: MacSocket;
  restic: Restic | null;
  rolling: Rolling;
  worker: JobWorker;
}

// `GET /status/live`, which the Mac host polls every 30 s: only what is cheap to read. What the
// phone last reported about itself and the Pendant, what the Mac says now, the pipeline, the
// backups, the credits and the switches.
export function liveStatus(
  db: Db,
  { excerpts, mac, restic, rolling, worker }: Parts
) {
  const beat = latestHeartbeat(db);
  return {
    backup: { ...backupStatus(db), restic: restic?.status() ?? null },
    identity: excerpts.identity(),
    mac: macStatus(mac, db.select().from(macWatch).get()),
    pendant: beat && pendantOf(beat),
    phoneHeartbeat: beat,
    pipeline: pipeline(db, mac, rolling),
    // The owner's switches: off, transcription or AI work waits until it is turned back on.
    switches: switches(),
    // ElevenLabs' credits as last read (every 5 min); used up, jobs wait queued, unsent.
    transcription: { quota: worker.credits() },
  };
}

// `GET /status`: the live part, and the scans of the last day: the archive's invariants, latency,
// the chain's steps and the problems reported.
export function status(db: Db, parts: Parts) {
  const live = liveStatus(db, parts);
  const day = new Date(Date.now() - DAY_MS);
  const problems = db
    .select({
      kind: diagnostics.kind,
      // An app error stands for its repeats within the hour.
      n: sql<number>`sum(coalesce(${diagnostics.body} ->> '$.error.count', 1))`,
    })
    .from(diagnostics)
    .where(
      and(
        gte(diagnostics.receivedAt, day),
        sql`${diagnostics.kind} <> 'metrics'`
      )
    )
    .groupBy(diagnostics.kind)
    .all();
  return {
    ...live,
    // Every turn in exactly one live conversation, nothing left of retired ones: each count 0.
    archive: archiveHealth(db),
    // Summaries run only on the Mac (the Max plan); what waits is `pipeline.ai`. Chapters: seconds
    // from a chapter's end to its summary, median and 90th percentile over the last day.
    intelligence: { chapters: chapterLatency(db, day) },
    // Where each chain last got to: a push sent, a token stored, what the phone saw.
    lastStepsLast24h: lastSteps(db, day),
    problemsLast24h: Object.fromEntries(
      problems.map((p) => [p.kind, Number(p.n)])
    ),
    // Latency: median and 90th percentile seconds over the last day, speech end to upload to words.
    transcription: { ...live.transcription, latency: latency(db, day) },
  };
}

const iso = (ms: number | null | undefined) =>
  ms ? new Date(ms).toISOString() : null;

// What is backed up: the phone's packs and snapshots in the bucket, completed jobs with and without
// their audio there, and the daily restic snapshot (null without RESTIC_*). Readers see it: no
// repository, no secret.
export const BackupStatus = z
  .object({
    jobsWithAudio: z.int(),
    jobsWithoutAudio: z.int(),
    latestSnapshotAt: z.iso.datetime().nullable(),
    packBytes: z.int(),
    packs: z.int(),
    restic: z
      .object({
        lastError: z.string().nullable(),
        lastSnapshotAt: z.iso.datetime().nullable(),
      })
      .nullable(),
  })
  .openapi("BackupStatus");

// Speaker recognition (apps/identity): whether it is set up (`identitySet`), and how the service last
// answered (null: not since the server started). Off, voices are not named.
export const IdentityStatus = z
  .object({
    configured: z.boolean(),
    lastError: z.string().nullable(),
    lastOkAt: z.iso.datetime().nullable(),
  })
  .openapi("IdentityStatus");

// Where the audio and the summaries are now, for the Mac host's menu: polled every 30 s, so a few
// small queries and the rolling drain's own list of what is due (summaries.ts holds the rule).
export const Pipeline = z
  .object({
    ai: z.object({
      blockedBy: z.enum(summaryWaits).nullable(),
      lastSummaryAt: z.iso.datetime().nullable(),
      running: z.array(
        z.object({
          conversationId: z.string(),
          startedAt: z.iso.datetime(),
          title: z.string().nullable(),
        })
      ),
      waiting: z.int(),
    }),
    transcription: z.object({
      atProvider: z.object({
        jobs: z.int(),
        oldestSentAt: z.iso.datetime().nullable(),
      }),
      failedLast24h: z.int(),
      fragments: z.object({ seconds: z.number() }),
      lastTranscriptAt: z.iso.datetime().nullable(),
      waiting: z.object({ blocks: z.int(), seconds: z.number() }),
    }),
  })
  .openapi("Pipeline");

const pipeline = (db: Db, mac: MacSocket, rolling: Rolling) => ({
  ai: aiNow(db, mac, rolling),
  transcription: transcriptionNow(db),
});

function transcriptionNow(db: Db): z.infer<typeof Pipeline>["transcription"] {
  // An aggregate answers one row. An open fragment's speech: its map's kept intervals (ms).
  interface Row {
    failed: number;
    lastTranscript: number | null;
    oldestSent: number | null;
    queued: number;
    queuedSeconds: number;
    speechMs: number;
    submitted: number;
  }
  const [t] = db.all<Row>(sql`
    select total(state = 'queued') as queued,
      total(case when state = 'queued' then prepared_duration_seconds end) as queuedSeconds,
      total(state = 'submitted') as submitted,
      min(case when state = 'submitted' then request_sent_at end) as oldestSent,
      total(state = 'failed' and updated_at >= ${Date.now() - DAY_MS}) as failed,
      max(completed_at) as lastTranscript,
      (select total(s.value ->> 1 - s.value ->> 0)
        from speech_fragments f, json_each(f.map, '$.segments') s
        where f.object_key is not null) as speechMs
    from transcription_jobs`) as [Row];
  return {
    atProvider: { jobs: t.submitted, oldestSentAt: iso(t.oldestSent) },
    failedLast24h: t.failed,
    fragments: { seconds: t.speechMs / 1000 },
    lastTranscriptAt: iso(t.lastTranscript),
    waiting: { blocks: t.queued, seconds: t.queuedSeconds },
  };
}

function aiNow(
  db: Db,
  mac: MacSocket,
  rolling: Rolling
): z.infer<typeof Pipeline>["ai"] {
  const running = db
    .select({
      conversationId: intelligenceRuns.conversationId,
      ownerTitle: conversations.ownerTitle,
      startedAt: intelligenceRuns.createdAt,
    })
    .from(intelligenceRuns)
    .innerJoin(
      conversations,
      eq(conversations.id, intelligenceRuns.conversationId)
    )
    .where(eq(intelligenceRuns.state, "running"))
    .all();
  const [summary] = db.all<{ at: number | null }>(
    sql`select max(updated_at) as at from intelligence_runs where state = 'valid'`
  );
  const rolls = new Set(running.map((r) => r.conversationId));
  return {
    blockedBy: summaryWait({ ai: switches().ai, macAble: mac.able() }),
    lastSummaryAt: iso(summary?.at),
    running: running.map((r) => ({
      conversationId: r.conversationId,
      startedAt: r.startedAt.toISOString(),
      title:
        r.ownerTitle ??
        latestValid(db, r.conversationId)?.result.title.text ??
        null,
    })),
    waiting: rolling.due().filter((id) => !rolls.has(id)).length,
  };
}

// The Pendant as the phone last saw it.
const { connection, pendant, recording } = HeartbeatUpload.shape;
export const PendantStatus = z
  .object({
    batteryPercent: pendant.shape.batteryPercent.unwrap().nullable(),
    charging: pendant.shape.charging.unwrap().nullable(),
    connection: connection.shape.state,
    knownAt: Heartbeat.shape.observedAt,
    recording: z.union([
      recording.shape.lastKnown.unwrap(),
      recording.shape.state,
    ]),
    recordingKnownAt: Heartbeat.shape.observedAt,
  })
  .openapi("PendantStatus");

const pendantOf = (
  beat: z.infer<typeof Heartbeat>
): z.infer<typeof PendantStatus> => ({
  batteryPercent: beat.pendant.batteryPercent ?? null,
  charging: beat.pendant.charging ?? null,
  connection: beat.connection.state,
  knownAt: beat.observedAt,
  ...pendantRecording(beat),
});

// The Mac helper: what its open socket says, else what it last left; null if never heard.
function macStatus(
  mac: MacSocket,
  stored: typeof macWatch.$inferSelect | undefined
) {
  const live = mac.live();
  const view = live ?? (stored ? macView(stored) : null);
  if (!view) {
    return null;
  }
  const dictatingSince = mac.dictatingSince();
  let state = live ? "watching" : "disconnected";
  if (view.asleep) {
    state = "asleep";
  }
  if (dictatingSince) {
    state = "dictating";
  }
  return {
    ...view,
    connected: live !== null,
    dictatingSince,
    // Whether summaries run on it now, and why not (auth, limit) when it says so.
    llm: mac.llmState(),
    state,
  };
}
