// The archive, read-only (DATABASE_PATH and AUDIO_DIR, as in Lifelog Host's server.env): the voices
// and his answers as the voice eval reads them (`exportVoices`), and where each drawn turn is in its
// job's audio. What it returns holds his voice and words: it is written to the bench's folder only.
import { join } from "node:path";
import { connect } from "@lifelog/db";
import {
  people,
  transcriptionJobs,
  transcripts,
  turns,
} from "@lifelog/db/schema";
import {
  answers,
  type Export,
  exportVoices,
} from "@lifelog/server/scripts/eval-voices";
import { excerptRange } from "@lifelog/server/src/excerpts";
import { eq, inArray } from "drizzle-orm";
import { draw, type Row } from "./sample";

function env(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`set ${name} as Lifelog Host's server.env does`);
  }
  return value;
}

export type Sample = ReturnType<typeof readSample>;
export type SampledTurn = Sample["turns"][number];

const chunks = <T>(all: T[], size: number) =>
  Array.from({ length: Math.ceil(all.length / size) }, (_, i) =>
    all.slice(i * size, (i + 1) * size)
  );

// Every turn he answered and `count` drawn others, each with its place in the audio. His answers
// are kept as the archive holds them: who spoke is decided when scoring (truth.ts), never stored.
export function readSample(count: number, seed: string) {
  const audioDir = env("AUDIO_DIR");
  const db = connect(env("DATABASE_PATH"), { readonly: true });
  try {
    const voices: Export = exportVoices(db);
    const answerOf = answers(voices);
    const rows: Row[] = voices.samples.map(
      ({ embedding: _, modelId: __, modelRevision: ___, ...row }) => row
    );
    const chosen = [
      ...rows.filter((r) => answerOf(r)),
      ...draw(
        rows.filter((r) => !answerOf(r)),
        count,
        seed
      ),
    ];
    const jobIds = [...new Set(chosen.map((r) => r.jobId))];
    const jobs = new Map(
      chunks(jobIds, 500)
        .flatMap((ids) =>
          db
            .select({
              captureStart: transcriptionJobs.captureStart,
              id: transcriptionJobs.id,
              key: transcriptionJobs.objectKey,
              parsed: transcripts.parsed,
            })
            .from(transcriptionJobs)
            .innerJoin(transcripts, eq(transcripts.jobId, transcriptionJobs.id))
            .where(inArray(transcriptionJobs.id, ids))
            .all()
        )
        .map((job) => [job.id, job])
    );
    const languages = new Map(
      chunks(jobIds, 500)
        .flatMap((ids) =>
          db
            .select({
              jobId: turns.jobId,
              language: turns.language,
              turnIndex: turns.turnIndex,
            })
            .from(turns)
            .where(inArray(turns.jobId, ids))
            .all()
        )
        .map((t) => [`${t.jobId}/${t.turnIndex}`, t.language])
    );
    return {
      assignments: voices.assignments,
      people: db
        .select({ id: people.id, isOwner: people.isOwner, name: people.name })
        .from(people)
        .all(),
      seed,
      turns: chosen.flatMap((row) => {
        const job = jobs.get(row.jobId);
        const turn = job?.parsed.turns[row.turnIndex];
        if (!(job?.key && turn)) {
          return [];
        }
        const [start, end] = excerptRange(turn);
        return [
          {
            ...row,
            audio: join(audioDir, job.key),
            // The UTC day: only to see the draw spread over days.
            day: job.captureStart?.toISOString().slice(0, 10) ?? "",
            end,
            language: languages.get(`${row.jobId}/${row.turnIndex}`) ?? "und",
            speakersInJob: new Set(job.parsed.turns.map((t) => t.speakerId))
              .size,
            start,
            text: turn.text,
          },
        ];
      }),
    };
  } finally {
    db.$client.close(true);
  }
}
