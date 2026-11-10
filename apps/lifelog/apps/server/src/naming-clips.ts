import type { Db } from "@lifelog/db";
import {
  conversationJobs,
  type JobMap,
  type Suggestion,
  transcriptionJobs,
  turns as turnRows,
} from "@lifelog/db/schema";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { NAMING, RECOGNITION } from "./config";
import { textOf } from "./elevenlabs";
import { ofItsSpeaker } from "./recognized-rows";
import { readVoices } from "./speaker-recognition";
import { keptAt, type LoadedTurn, loadTurns, timedWords } from "./transcript";

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

// The clips of an open card, best first: the clean turns (samples) that clearly sound like its
// voice (RECOGNITION.matchThreshold), 5–20 s before other lengths, then the rest by likeness;
// each is cut to NAMING.clipSeconds. A turn the provider gave one speaker can hold several
// people: it sounds unlike the voice, so it comes late, and one that clearly is someone else
// (RECOGNITION.notThem) only when nothing else is left.
export function readClip(db: Db) {
  const loaded = new Map<string, LoadedTurn[]>();
  const holders = Map.groupBy(
    db.select().from(conversationJobs).all(),
    (r) => r.jobId
  );
  const bucket = new Map<string, JobMap | null>();
  const turnsOf = (conversationId: string) => {
    const turns =
      loaded.get(conversationId) ?? loadTurns(db, conversationId)?.turns ?? [];
    loaded.set(conversationId, turns);
    return turns;
  };
  // The turn in the live conversations that hold its job now (a regroup can split a job).
  const turnOf = (jobId: string, turnIndex: number) => {
    for (const { conversationId: id } of holders.get(jobId) ?? []) {
      const turn = turnsOf(id).find(
        (t) => t.ref.jobId === jobId && t.ref.turnIndex === turnIndex
      );
      if (turn) {
        return { conversationId: id, turn };
      }
    }
    return null;
  };
  // The job's map when it has bucket audio, which the map places in capture time.
  const bucketMap = (jobId: string) => {
    if (bucket.has(jobId)) {
      return bucket.get(jobId) ?? null;
    }
    const row = db
      .select({ key: transcriptionJobs.objectKey, map: transcriptionJobs.map })
      .from(transcriptionJobs)
      .where(eq(transcriptionJobs.id, jobId))
      .get();
    const map = row?.key ? row.map : null;
    bucket.set(jobId, map);
    return map;
  };
  return (ref: { jobId: string; turnIndex: number }) => {
    const found = turnOf(ref.jobId, ref.turnIndex);
    return found
      ? {
          ...found,
          clip: clipOf(found.conversationId, found.turn, bucketMap(ref.jobId)),
        }
      : null;
  };
}

export function cardClips(
  db: Db,
  reader = readVoices(db),
  clip = readClip(db)
) {
  const { rank } = reader;
  return (card: Pick<Suggestion, "kind" | "personId" | "voices">): Clip[] => {
    const ranked = rank(
      card.voices,
      card.kind === "known_person" ? card.personId : null
    );
    const fit = ranked.filter((r) => r.score > RECOGNITION.notThem);
    const usable = fit.length > 0 ? fit : ranked;
    const fits = (seconds: number) =>
      seconds >= NAMING.clipMinSeconds && seconds <= NAMING.clipSeconds;
    const sure = usable.filter((r) => r.score >= RECOGNITION.matchThreshold);
    const ordered = [
      ...sure.filter((r) => fits(r.sample.durationSeconds)),
      ...sure.filter((r) => !fits(r.sample.durationSeconds)),
      ...usable.filter((r) => r.score < RECOGNITION.matchThreshold),
    ];
    // A voice with no sample yet (most turns before the server cut excerpts): its own turns with the
    // most words, never one named on its own, so the card still has something to hear.
    const picks =
      ordered.length > 0
        ? ordered.map((r) => r.sample)
        : db
            .select({ jobId: turnRows.jobId, turnIndex: turnRows.turnIndex })
            .from(turnRows)
            .where(
              and(
                or(
                  ...card.voices.map((v) =>
                    and(
                      eq(turnRows.jobId, v.jobId),
                      eq(turnRows.speakerLabel, v.speakerLabel)
                    )
                  )
                ),
                // Same own-row exclusion as readOwnTurns, before word ordering and LIMIT.
                ofItsSpeaker(turnRows.jobId, turnRows.turnIndex)
              )
            )
            .orderBy(desc(sql`json_array_length(${turnRows.words})`))
            .limit(NAMING.clips * 3)
            .all();
    const clips: Clip[] = [];
    for (const sample of picks) {
      if (clips.length >= NAMING.clips) {
        break;
      }
      const found = clip(sample);
      if (found) {
        clips.push(found.clip);
      }
    }
    return clips;
  };
}
