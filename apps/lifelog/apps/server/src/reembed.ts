// The owner's one-off of 11 Nov 2026 (docs/decisions.md): every stored voice sample embedded again by
// the speech service's new speaker model, run elsewhere on the audio the listing names, then written
// through the server by sample id (the server is the archive's one writer). Removed after its run.
import type { Db } from "@lifelog/db";
import {
  transcriptionJobs,
  transcripts,
  voiceProfiles,
  voiceSamples,
} from "@lifelog/db/schema";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { logChange } from "./change-log";
import { excerptRange, mayHear } from "./excerpts";

export interface Model {
  modelId: string;
  modelRevision: string;
}

const onAnother = (model: Model) =>
  or(
    ne(voiceSamples.modelId, model.modelId),
    ne(voiceSamples.modelRevision, model.modelRevision)
  );

// The samples not yet on `model`, by job, each with the seconds of its job's audio it was cut from;
// only jobs whose audio the speech service may hear (excerpts.ts `mayHear`). Read by the bench, on a
// read-only connection: it parses every such transcript.
export const reembedListing = (db: Db, model: Model) =>
  db
    .select({
      id: transcripts.jobId,
      map: transcriptionJobs.map,
      objectKey: transcriptionJobs.objectKey,
      parsed: transcripts.parsed,
    })
    .from(transcripts)
    .innerJoin(transcriptionJobs, eq(transcriptionJobs.id, transcripts.jobId))
    .where(
      sql`exists (select 1 from voice_samples s where s.job_id = ${transcripts.jobId}
        and (s.model_id <> ${model.modelId} or s.model_revision <> ${model.modelRevision}))`
    )
    .all()
    .flatMap((job) => {
      const samples = mayHear(db, job)
        ? db
            .select({ id: voiceSamples.id, turnIndex: voiceSamples.turnIndex })
            .from(voiceSamples)
            .where(and(eq(voiceSamples.jobId, job.id), onAnother(model)))
            .all()
            .flatMap(({ id, turnIndex }) => {
              const turn = job.parsed.turns[turnIndex];
              return turn ? [{ id, range: excerptRange(turn) }] : [];
            })
        : [];
      return samples.length > 0 && job.objectKey
        ? [{ key: job.objectKey, samples }]
        : [];
    });

// The new vectors onto their samples. The number written.
export const reembed = (
  db: Db,
  model: Model,
  vectors: { embedding: number[]; id: string }[]
) =>
  db.transaction((tx) => {
    const jobs = new Set(
      vectors.flatMap(({ embedding, id }) =>
        tx
          .update(voiceSamples)
          .set({ embedding, ...model })
          .where(eq(voiceSamples.id, id))
          .returning({ jobId: voiceSamples.jobId })
          .all()
          .map((r) => r.jobId)
      )
    );
    for (const jobId of jobs) {
      logChange(tx, "job", jobId);
    }
    return vectors.length;
  });

// The samples left on another model go, with the evidence they were: their audio may not be heard
// again, and a voice is judged in one model. The number removed.
export const dropOtherModels = (db: Db, model: Model) =>
  db.transaction((tx) => {
    const left = tx
      .select({ id: voiceSamples.id, jobId: voiceSamples.jobId })
      .from(voiceSamples)
      .where(onAnother(model))
      .all();
    // ponytail: SQLite's variable limit; a few thousand rows once.
    for (let i = 0; i < left.length; i += 500) {
      const ids = left.slice(i, i + 500).map((s) => s.id);
      tx.delete(voiceProfiles)
        .where(inArray(voiceProfiles.sampleId, ids))
        .run();
      tx.delete(voiceSamples).where(inArray(voiceSamples.id, ids)).run();
    }
    for (const jobId of new Set(left.map((s) => s.jobId))) {
      logChange(tx, "job", jobId);
    }
    return left.length;
  });
