// The server cuts its own voice excerpts (rebuild P3, docs/processing.md "Speakers").
//
// When a block's job is stored, its clean turns (people.ts `uncleanTurn`, the one rule) are cut
// from the block's own Ogg Opus, whose timeline is the one the turns' seconds are in. The audio goes
// to apps/identity once with the turns' ranges; the embeddings are stored as voice samples of
// source "server", and recognition runs. Nothing here transcribes, buys or stores audio. A turn the
// phone sampled before the rebuild keeps its sample. Identity gets the whole Ogg, so a block whose
// map touches a quiet range (dictation, playback) is never sent, and neither is an old job's audio
// (sent again by the phone, `PUT /jobs/{id}/audio`): it may hold dictation from before the Mac kept
// quiet ranges.

import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  type ParsedTranscript,
  speakerAssignments,
  transcriptionJobs,
  transcripts,
  voiceSamples,
} from "@lifelog/db/schema";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { type AudioStore, isBlockKey } from "./audio-store";
import { type Config, EXCERPTS } from "./config";
import { touchesQuiet } from "./cutter";
import { record } from "./events";
import {
  holdingConversations,
  isRejected,
  keepServerSamples,
  loadTranscript,
  recognize,
  speakerOf,
  uncleanTurn,
} from "./people";
import { embedRanges, speechServiceSet } from "./speech-service";
import { switches } from "./switches";

// The clean turns of a job without a sample yet, longest first up to the cap, in order.
function wantedTurns(db: Db, jobId: string, parsed: ParsedTranscript) {
  const sampled = new Set(
    db
      .select({ turnIndex: voiceSamples.turnIndex })
      .from(voiceSamples)
      .where(eq(voiceSamples.jobId, jobId))
      .all()
      .map((r) => r.turnIndex)
  );
  const assignments = db
    .select()
    .from(speakerAssignments)
    .where(eq(speakerAssignments.jobId, jobId))
    .all();
  return parsed.turns
    .flatMap((turn, index) => {
      const assignment = speakerOf(assignments, turn.speakerId, index);
      return turn.speakerId &&
        !isRejected(assignment) &&
        !sampled.has(index) &&
        !uncleanTurn(parsed, index)
        ? [{ index, speaker: turn.speakerId, turn }]
        : [];
    })
    .sort((a, b) => b.turn.end - b.turn.start - (a.turn.end - a.turn.start))
    .slice(0, EXCERPTS.maxPerJob)
    .sort((a, b) => a.index - b.index);
}
type Wanted = Awaited<ReturnType<typeof wantedTurns>>;

// The seconds of a turn that are embedded: its first `maxSeconds`.
export const excerptRange = (turn: {
  end: number;
  start: number;
}): [number, number] => [
  turn.start,
  Math.min(turn.end, turn.start + EXCERPTS.maxSeconds),
];

// The bucket key of a job's audio identity may hear: a block's that no quiet range touches.
// "never" for any other (an old job's, or one with dictation or playback in it); null when there
// is nothing to cut (no audio, or cut already).
// Whether identity may hear a job's audio.
export const mayHear = (
  db: Db,
  job: {
    map: Parameters<typeof touchesQuiet>[1] | null;
    objectKey: string | null;
  }
) =>
  !!job.objectKey &&
  isBlockKey(job.objectKey) &&
  !!job.map &&
  !touchesQuiet(db, job.map);

function audioToCut(db: Db, jobId: string) {
  const row = db
    .select({
      cutAt: transcripts.excerptsAt,
      map: transcriptionJobs.map,
      objectKey: transcriptionJobs.objectKey,
    })
    .from(transcripts)
    .innerJoin(transcriptionJobs, eq(transcriptionJobs.id, transcripts.jobId))
    .where(eq(transcripts.jobId, jobId))
    .get();
  if (!row?.objectKey || row.cutAt) {
    return null;
  }
  return mayHear(db, row) ? row.objectKey : "never";
}

// ponytail: in-process, one replica, like the other loops; `busy` keeps a webhook and the tick
// from cutting one job twice.
export function excerptSampler(db: Db, config: Config, audio: AudioStore) {
  const busy = new Set<string>();
  let draining = false;
  // How the identity service last answered, for `GET /status/live`: no probe per poll.
  let lastOkAt: string | null = null;
  let lastError: string | null = null;

  // Nothing more to cut from this job: marked, so the tick leaves it.
  const done = (jobId: string) => {
    keepServerSamples(db, jobId, []);
    return 0;
  };

  // The audio and the turns' ranges go to the identity service once; the embeddings are stored and
  // the job recognized. As `cut`.
  async function embedAndKeep(
    jobId: string,
    conversationId: string,
    wanted: Wanted,
    ogg: Uint8Array
  ) {
    const result = await embedRanges(
      config,
      ogg,
      wanted.map(({ turn }) => excerptRange(turn))
    );
    if (!("embeddings" in result)) {
      if (result.error === "identity_unavailable") {
        lastError = result.message;
      }
      if (result.error !== "identity_busy") {
        record(db, "excerpts.failed", {
          error: result.error,
          job: jobId,
        });
      }
      // The same bytes fail every time: the job is left as it is.
      return result.error === "invalid_audio" ? done(jobId) : null;
    }
    lastOkAt = clock().toISOString();
    lastError = null;
    const samples = wanted.flatMap(({ index, speaker, turn }, i) => {
      const e = result.embeddings[i];
      return e
        ? [
            {
              conversationId,
              durationSeconds: Math.min(
                e.durationSeconds,
                turn.end - turn.start
              ),
              embedding: e.embedding,
              jobId,
              modelId: e.modelId,
              modelRevision: e.modelRevision,
              speakerLabel: speaker,
              turnIndex: index,
            },
          ]
        : [];
    });
    keepServerSamples(db, jobId, samples);
    recognize(db, jobId);
    record(db, "excerpts.cut", {
      job: jobId,
      stored: samples.length,
      turns: wanted.length,
    });
    return samples.length;
  }

  // Cuts one job's clean turns. The number of samples stored, or null when it must be tried
  // again (identity busy or down, the bucket unreachable, no conversation holds the job yet).
  async function cut(jobId: string): Promise<number | null> {
    const key = audioToCut(db, jobId);
    if (key === null) {
      return 0;
    }
    if (key === "never") {
      return done(jobId);
    }
    const transcript = loadTranscript(db, jobId);
    const [conversationId] = holdingConversations(db, jobId);
    if (!(transcript && conversationId)) {
      return null;
    }
    const wanted = wantedTurns(db, jobId, transcript.parsed);
    if (wanted.length === 0) {
      return done(jobId);
    }
    const ogg = await audio.get(key).catch(() => undefined);
    if (ogg === undefined) {
      return null;
    }
    if (!ogg) {
      record(db, "excerpts.skipped", { job: jobId, reason: "no_audio" });
      return done(jobId);
    }
    return embedAndKeep(jobId, conversationId, wanted, ogg);
  }

  const job = async (jobId: string) => {
    if (
      !(speechServiceSet(config) && switches().transcription) ||
      busy.has(jobId)
    ) {
      return null;
    }
    busy.add(jobId);
    try {
      db.update(transcripts)
        .set({ excerptsAttemptedAt: clock() })
        .where(eq(transcripts.jobId, jobId))
        .run();
      return await cut(jobId);
    } finally {
      busy.delete(jobId);
    }
  };

  return {
    // Speaker recognition: off without IDENTITY_URL and IDENTITY_SECRET, else the service's last answer.
    identity: () => ({
      configured: speechServiceSet(config),
      lastError,
      lastOkAt,
    }),
    // After a transcript is stored.
    job,
    // Held jobs with bucket audio not cut yet, least recently attempted first. A failed job
    // yields to the rest on the next tick; overlapping ticks never drain the same batch.
    async pending() {
      if (draining) {
        return;
      }
      draining = true;
      try {
        const rows = db
          .select({ id: transcripts.jobId })
          .from(transcripts)
          .innerJoin(
            transcriptionJobs,
            eq(transcriptionJobs.id, transcripts.jobId)
          )
          .where(
            and(
              isNull(transcripts.excerptsAt),
              isNotNull(transcriptionJobs.objectKey),
              sql`exists (select 1 from conversation_jobs c where c.job_id = ${transcripts.jobId})`
            )
          )
          .orderBy(
            asc(transcripts.excerptsAttemptedAt),
            asc(transcripts.createdAt),
            asc(transcripts.jobId)
          )
          .limit(50)
          .all();
        for (const { id } of rows) {
          // biome-ignore lint/performance/noAwaitInLoops: the identity service takes one job at a time
          await job(id);
        }
      } finally {
        draining = false;
      }
    },
  };
}
export type ExcerptSampler = ReturnType<typeof excerptSampler>;
