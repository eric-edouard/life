// The server cuts its own voice excerpts (rebuild P3, docs/voice/processing.md "Speakers").
//
// When a block's job is stored, its clean turns (people.ts `uncleanTurn`, the one rule) are cut
// from the block's own Ogg Opus, whose timeline is the one the turns' seconds are in. The audio goes
// to apps/speech once with the turns' ranges; the embeddings are stored as voice samples of
// source "server", and recognition runs. Nothing here transcribes, buys or stores audio. A turn the
// phone sampled before the rebuild keeps its sample. Identity gets the whole Ogg, so a block whose
// map touches a quiet range (dictation, playback) is never sent, and neither is an old job's audio
// (sent again by the phone, `PUT /jobs/{id}/audio`): it may hold dictation from before the Mac kept
// quiet ranges.

import type { Db } from "@life/voice-db";
import {
  type ParsedTranscript,
  transcriptionJobs,
  transcripts,
  voiceSamples,
} from "@life/voice-db/schema";
import { and, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { type AudioStore, isBlockKey } from "./audio-store";
import { type Config, EXCERPTS, RECOGNITION } from "./config";
import { touchesQuiet } from "./cutter";
import { record } from "./events";
import { embedRanges, identitySet } from "./identity";
import {
  keepServerSamples,
  loadTranscript,
  recognize,
  uncleanTurn,
} from "./people";
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
  return parsed.turns
    .flatMap((turn, index) =>
      turn.speakerId && !sampled.has(index) && !uncleanTurn(parsed, index)
        ? [{ index, speaker: turn.speakerId, turn }]
        : []
    )
    .sort((a, b) => b.turn.end - b.turn.start - (a.turn.end - a.turn.start))
    .slice(0, EXCERPTS.maxPerJob)
    .sort((a, b) => a.index - b.index);
}
type Wanted = Awaited<ReturnType<typeof wantedTurns>>;

// The bucket key of a job's audio identity may hear: a block's that no quiet range touches.
// "never" for any other (an old job's, or one with dictation or playback in it); null when there
// is nothing to cut (no audio, or cut already).
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
  return isBlockKey(row.objectKey) && row.map && !touchesQuiet(db, row.map)
    ? row.objectKey
    : "never";
}

// ponytail: in-process, one replica, like the other loops; `busy` keeps a webhook and the tick
// from cutting one job twice.
export function excerptSampler(db: Db, config: Config, audio: AudioStore) {
  const busy = new Set<string>();
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
      wanted.map(({ turn }) => [
        turn.start,
        Math.min(turn.end, turn.start + EXCERPTS.maxSeconds),
      ])
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
    lastOkAt = new Date().toISOString();
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
    if (!transcript?.conversationId) {
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
    return embedAndKeep(jobId, transcript.conversationId, wanted, ogg);
  }

  const job = async (jobId: string) => {
    if (!(identitySet(config) && switches().transcription) || busy.has(jobId)) {
      return null;
    }
    busy.add(jobId);
    try {
      return await cut(jobId);
    } finally {
      busy.delete(jobId);
    }
  };

  return {
    // Speaker recognition: off without IDENTITY_URL and IDENTITY_SECRET, else the service's last answer.
    identity: () => ({
      configured: identitySet(config),
      lastError,
      lastOkAt,
    }),
    // After a transcript is stored.
    job,
    // Every recent job with bucket audio not cut yet (identity was down, the server restarted, a
    // reconcile completed it), newest first. Called by the 5-minute tick.
    async pending() {
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
            gt(
              transcripts.createdAt,
              new Date(Date.now() - RECOGNITION.keepDays * 86_400_000)
            )
          )
        )
        .orderBy(desc(transcripts.createdAt))
        .limit(50)
        .all();
      for (const { id } of rows) {
        // biome-ignore lint/performance/noAwaitInLoops: the identity service takes one job at a time
        await job(id);
      }
    },
  };
}
export type ExcerptSampler = ReturnType<typeof excerptSampler>;
