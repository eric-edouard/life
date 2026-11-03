// A conversation's transcript as intelligence, search and the feed read it: the turns
// starting in its range (the one rule), with one name per speaker, minus media and quiet ranges.

import type { Db } from "@lifelog/db";
import {
  type JobMap,
  transcriptionJobs as jobs,
  quietRanges,
  type Turn,
  type TurnRef,
  type TurnWord,
  turns as turnRows,
  unfinishedJobStates,
  type Word,
} from "@lifelog/db/schema";
import { and, asc, gt, gte, inArray, lt, min } from "drizzle-orm";
import { textOf } from "./elevenlabs";
import { assignmentsByJob, speakerOf, voiceId } from "./people";

// Where each kept interval begins in the prepared audio (ms): the map's `starts` when its audio was
// joined from fragments (audio.ts `joinOggOpus`), else each one separator after the one before.
export function startsOf({ segments, separatorMs, starts }: JobMap) {
  if (starts) {
    return starts;
  }
  let next = 0;
  return segments.map(([start, end]) => {
    const at = next;
    next += end - start + separatorMs;
    return at;
  });
}

// Capture instant (epoch ms) of a prepared-audio position. A position before an interval's start
// (in a separator) moves forward to it, as the client's TimeMap rounds turn starts. Cases both
// read: fixtures/time-map.json.
export function captureMillis(map: JobMap, preparedSeconds: number) {
  const position = Math.round(preparedSeconds * 1000);
  const starts = startsOf(map);
  const i = map.segments.findIndex(
    ([from, to], k) => position < (starts[k] ?? 0) + to - from
  );
  const [start = 0] = map.segments[i] ?? [];
  return i < 0
    ? null
    : Math.round(start + Math.max(0, position - (starts[i] ?? 0)));
}

// The kept interval holding capture instant `at` (epoch ms): where it ends, and where `at` plays in
// the prepared audio (ms), `captureMillis` the other way. Null outside the kept intervals.
export function keptAt(map: JobMap, at: number) {
  const i = map.segments.findIndex(([from, to]) => from <= at && at < to);
  const [start = 0, end = 0] = map.segments[i] ?? [];
  return i < 0 ? null : { end, prepared: (startsOf(map)[i] ?? 0) + at - start };
}

// One transcript turn as intelligence and search read it.
export interface LoadedTurn {
  // Capture instant of its end (ISO).
  endedAt: string | null;
  // Its end in capture time, in seconds since the epoch.
  endSeconds: number;
  languageCode: string;
  // The person the owner named for it, if any.
  person: { id: string; name: string } | null;
  ref: TurnRef;
  // What every reader calls its speaker (`speakerName`).
  speaker: string;
  // The transcript's own label (speaker_0), null when unlabeled; a voice is its job and label.
  speakerLabel: string | null;
  startSeconds: number;
  text: string;
  // Its words as kept, in capture time: `text` rebuilt from them.
  words: TurnWord[];
}

// Each word as the phone lights it while it plays: [start, end] in ms from `from`, and its length
// in the text (UTF-16, with the spacing before it but the first's): `textOf(words)` piece by piece.
export const timedWords = (words: TurnWord[], from: number) =>
  words.map((w, i): [number, number, number] => [
    w.start - from,
    w.end - from,
    (i === 0 ? 0 : w.spacing.length) + w.text.length,
  ]);

// The one name of a speaker, in transcripts, the feed and summaries alike: the person's (the
// owner's too), else "Speaker N", the conversation's voices without a person numbered in order of
// first appearance.
function speakerNames(
  turns: {
    person: { name: string } | null;
    ref: { jobId: string };
    speakerLabel: string | null;
  }[]
) {
  const numbered = new Map<string, string>();
  for (const t of turns) {
    const key = voiceId(t.ref.jobId, t.speakerLabel);
    if (!(t.person || numbered.has(key))) {
      numbered.set(key, `Speaker ${numbered.size + 1}`);
    }
  }
  return (t: (typeof turns)[number]) =>
    t.person?.name ??
    numbered.get(voiceId(t.ref.jobId, t.speakerLabel)) ??
    "Speaker";
}

// The conversation's turns in order: those that start inside its range, with owner-assigned
// speaker names. Turns the owner marked as media (a video, TV) and words inside quiet ranges
// (dictation, playback) are left out of everything built on this: summaries, search, the feed.
// `pendingFrom` is where the first job over it still to transcribe starts: the words before it are
// all there. Null for an unknown conversation.
export function loadTurns(db: Db, conversationId: string) {
  const conversation = db.query.conversations
    .findFirst({
      where: (c, { eq: is }) => is(c.id, conversationId),
    })
    .sync();
  if (!conversation) {
    return null;
  }
  const { captureEndedAt: end, captureStartedAt: start } = conversation;
  const rows = db
    .select()
    .from(turnRows)
    .where(and(gte(turnRows.startAt, start), lt(turnRows.startAt, end)))
    .orderBy(asc(turnRows.startAt))
    .all();
  const [first] = db
    .select({ at: min(jobs.captureStart) })
    .from(jobs)
    .where(
      and(
        inArray(jobs.state, unfinishedJobStates),
        lt(jobs.captureStart, end),
        gt(jobs.captureEnd, start)
      )
    )
    .all();
  const quiet = quietIn(db, start, end);
  const assigned = assignmentsByJob(
    db,
    rows.map((t) => t.jobId)
  );
  const shown = rows.flatMap((t) => {
    const assignedTo = speakerOf(
      assigned.get(t.jobId),
      t.speakerLabel,
      t.turnIndex
    );
    const kept = keptWords(t.words, t.startAt.getTime(), quiet);
    if (assignedTo?.status === "media" || !kept) {
      return [];
    }
    const from = kept[0]?.start ?? t.startAt.getTime();
    const to = kept.at(-1)?.end ?? t.endAt.getTime();
    return [
      {
        endedAt: new Date(to).toISOString(),
        endSeconds: to / 1000,
        languageCode: t.language,
        person: personOf(assignedTo),
        ref: {
          capturedAt: new Date(from).toISOString(),
          jobId: t.jobId,
          turnIndex: t.turnIndex,
        },
        speakerLabel: t.speakerLabel,
        startSeconds: from / 1000,
        text: kept === t.words ? t.text : textOf(kept),
        words: kept,
      },
    ];
  });
  const nameOf = speakerNames(shown);
  const loaded: LoadedTurn[] = shown.map((t) => ({ ...t, speaker: nameOf(t) }));
  return {
    languages: [...new Set(loaded.map((t) => t.languageCode))],
    ownerTitle: conversation.ownerTitle,
    pendingFrom: first?.at?.getTime() ?? null,
    // Its capture range (epoch ms).
    range: [start.getTime(), end.getTime()] as const,
    turns: loaded,
  };
}

const quietIn = (db: Db, from: Date, to: Date) =>
  db
    .select()
    .from(quietRanges)
    .where(and(lt(quietRanges.startedAt, to), gt(quietRanges.endedAt, from)))
    .all()
    .map((q) => [q.startedAt.getTime(), q.endedAt.getTime()] as const);

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

// The words of a turn: its speaker's, inside its span.
export const ownWords = (turn: Turn, words: Word[]) =>
  words.filter(
    (w) =>
      w.speakerId === turn.speakerId &&
      w.start >= turn.start &&
      w.end <= turn.end
  );

// The person the owner named in an assignment, if any.
export const personOf = (
  assigned:
    | { personId: string | null; personName: string | null; status: string }
    | undefined
) =>
  assigned?.status === "person" && assigned.personId && assigned.personName
    ? { id: assigned.personId, name: assigned.personName }
    : null;
