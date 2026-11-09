import type { JobMap } from "@lifelog/db/schema";
import { NAMING } from "./config";
import { textOf } from "./elevenlabs";
import { keptAt, type LoadedTurn, timedWords } from "./transcript";

// One clip a card plays: a clean turn of its voice, with the words said before it is cut. `audio`
// places it in the job's bucket audio (`GET /transcripts/{jobId}/audio`, seconds into that file):
// the server's own copy, for every job that has one. Only a job from before the bucket has none;
// then the phone plays `at` to `until` from its own recording. `words` time both, from `at`.
// The turn (`jobId`, `speakerLabel`, `turnIndex`) is what "several people" names in place, and
// `personId` who it reads as now.
export interface Clip {
  at: string | null;
  audio: { end: number; jobId: string; start: number } | null;
  conversationId: string;
  jobId: string;
  personId: string | null;
  speakerLabel: string | null;
  text: string;
  turnIndex: number;
  until: string | null;
  words: [number, number, number][];
}

// A turn as a card plays it: its words begun within NAMING.clipSeconds, from the first to the end
// of the last (never past the cut), so it stops where its voice does. With bucket audio it also
// stops where its stretch of kept speech does: the bucket audio has the silence after it cut out,
// so only inside one stretch do capture time and the file's time run together (docs/formats.md).
export function clipOf(
  conversationId: string,
  turn: LoadedTurn,
  // The job's map when it has bucket audio.
  map: JobMap | null
): Clip {
  const at = turn.ref.capturedAt;
  const from = turn.startSeconds * 1000;
  const kept = map && keptAt(map, from);
  const cut = Math.min(
    from + NAMING.clipSeconds * 1000,
    kept?.end ?? Number.POSITIVE_INFINITY
  );
  const said = turn.words.filter((w) => w.start < cut);
  const end = Math.min(said.at(-1)?.end ?? turn.endSeconds * 1000, cut);
  return {
    at,
    audio: kept
      ? {
          end: (kept.prepared + end - from) / 1000,
          jobId: turn.ref.jobId,
          start: kept.prepared / 1000,
        }
      : null,
    conversationId,
    jobId: turn.ref.jobId,
    personId: turn.person?.id ?? null,
    speakerLabel: turn.speakerLabel,
    text: textOf(said),
    turnIndex: turn.ref.turnIndex,
    until: new Date(end).toISOString(),
    words: timedWords(said, from),
  };
}
