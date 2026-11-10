// Current transcript visibility applies to stored inference quotes on every output.
import type { Db } from "@lifelog/db";
import {
  quietRanges,
  type SpeakerInference,
  speakerAssignments,
  turns,
} from "@lifelog/db/schema";
import { and, eq, gt, lt } from "drizzle-orm";
import { textOf } from "./elevenlabs";
import { speakerOf } from "./recognized-rows";

export function readInference(
  db: Pick<Db, "select">,
  inference: SpeakerInference | null | undefined
) {
  if (!inference) {
    return null;
  }
  return {
    ...inference,
    evidence: inference.evidence.filter((e) =>
      readTurnText(db, e.jobId, e.turnIndex)?.includes(e.quote)
    ),
  };
}

// Current visible words of a stored turn, including media corrections.
export function readTurnText(
  db: Pick<Db, "select">,
  jobId: string,
  turnIndex: number
) {
  const turn = db
    .select()
    .from(turns)
    .where(and(eq(turns.jobId, jobId), eq(turns.turnIndex, turnIndex)))
    .get();
  if (!turn) {
    return null;
  }
  const assigned = db
    .select()
    .from(speakerAssignments)
    .where(eq(speakerAssignments.jobId, jobId))
    .all();
  if (speakerOf(assigned, turn.speakerLabel, turnIndex)?.status === "media") {
    return null;
  }
  const quiet = db
    .select()
    .from(quietRanges)
    .where(
      and(
        lt(quietRanges.startedAt, turn.endAt),
        gt(quietRanges.endedAt, turn.startAt)
      )
    )
    .all()
    .map((q) => [q.startedAt.getTime(), q.endedAt.getTime()] as const);
  const kept = keptWords(turn.words, turn.startAt.getTime(), quiet);
  if (kept === null) {
    return null;
  }
  return kept === turn.words ? turn.text : textOf(kept);
}

// The one hiding rule (summaries, search, the feed): a word that starts inside a quiet
// range is the owner dictating to the Mac and goes; a turn without words goes by its own start.
// `at` places a start in capture time (epoch ms; null: unplaced, kept). Returns `words` itself
// when nothing goes, null when everything does.
export function keptWords<W extends { start: number }>(
  words: W[],
  turnStart: number,
  quiet: (readonly [number, number])[],
  at: (start: number) => number | null = (start) => start
): W[] | null {
  const isQuiet = (start: number) => {
    const t = at(start);
    return t !== null && quiet.some(([from, to]) => from <= t && t < to);
  };
  if (words.length === 0) {
    return isQuiet(turnStart) ? null : words;
  }
  const kept = words.filter((w) => !isQuiet(w.start));
  if (kept.length === words.length) {
    return words;
  }
  return kept.length > 0 ? kept : null;
}
