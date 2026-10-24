// Words in capture time, one row per transcript turn (`turns`): a cache rebuilt from a job's
// parsed transcript and its time map, with one mapping, `captureMillis`. Each job carries its
// map (`transcription_jobs.map`): a block's from its fragments' maps (cutter.ts) or its upload, an
// older job's copied from the conversation parts that cited it (migration `rebuild`). A
// conversation shows the turns that start inside its range; the feed reads them (feed.ts).

import type { Db } from "@lifelog/db";
import {
  holdsTurn,
  type JobMap,
  transcriptionJobs as jobs,
  type ParsedTranscript,
  type TurnWord,
  transcripts,
  turns,
} from "@lifelog/db/schema";
import { eq, sql } from "drizzle-orm";
import { logChange, logPlacedIn, turnRef } from "./change-log";
import { PARSER_VERSION, parseTranscript } from "./elevenlabs";
import { captureMillis, keptAt, ownWords } from "./transcript";

const INSERT_CHUNK = 200;

// The first and last capture instants of a map, or null when it keeps nothing.
export function captureRange({ segments }: JobMap) {
  if (segments.length === 0) {
    return null;
  }
  return {
    end: Math.max(...segments.map(([, to]) => to)),
    start: Math.min(...segments.map(([from]) => from)),
  };
}

// A turn's rows: the turns whose start falls on the map, their words on it too. Index = the
// turn's index in the transcript, which the owner's speaker assignments use. A word stays in the
// interval it starts in: the provider stretches one over the separators and the cut-out silence
// after it (a 2-letter word lasting 94 s, Oct 13), which mapped forward would cover that silence.
// A turn ends with its last word (docs/formats.md, "The time map").
function buildTurns(parsed: ParsedTranscript, language: string, map: JobMap) {
  // The end of `seconds` of audio from capture instant `at`, cut at the end of its interval.
  const endFrom = (at: number, seconds: number) =>
    Math.min(
      keptAt(map, at)?.end ?? at,
      at + Math.max(0, Math.round(seconds * 1000))
    );
  return parsed.turns.flatMap((turn, turnIndex) => {
    const start = captureMillis(map, turn.start);
    if (start === null) {
      return [];
    }
    const words = ownWords(turn, parsed.words).flatMap((w): TurnWord[] => {
      const at = captureMillis(map, w.start);
      return at === null
        ? []
        : [
            {
              end: endFrom(at, w.end - w.start),
              spacing: w.spacing,
              start: at,
              text: w.text,
            },
          ];
    });
    return {
      endAt: new Date(
        words.at(-1)?.end ?? endFrom(start, turn.end - turn.start)
      ),
      language,
      speakerLabel: turn.speakerId,
      startAt: new Date(start),
      text: turn.text,
      turnIndex,
      words,
    };
  });
}

// Rebuilds one completed job's turns from its transcript and map; a job without a map has none.
// A transcript parsed by an older parser first gets the current words from its raw answer (its
// turns stay as stored: owner assignments point at their indexes). The feed hears of the job's
// turns, and of every turn, chapter and title of a conversation where they land before words
// already there: a voice that speaks earlier renumbers its "Speaker N" (transcript.ts
// `speakerNames`). Returns the rows written.
export const rebuildTurns = (db: Db, jobId: string) =>
  db.transaction((tx) => rebuildTurnsIn(tx, jobId));

// `rebuildTurns` in the caller's transaction (a completion, a moved map), so the words land with
// what made them; it logs, so only other logs may follow it.
export function rebuildTurnsIn(
  tx: Pick<Db, "all" | "delete" | "insert" | "run" | "select" | "update">,
  jobId: string
) {
  const refs = writeTurns(tx, jobId);
  const renumbered = landedEarlier(tx, jobId);
  logChange(tx, "turn", refs.all);
  logPlacedIn(
    tx,
    renumbered.map((c): [number, number] => [c.start, c.end])
  );
  logChange(
    tx,
    "conversation",
    renumbered.map((c) => c.id)
  );
  logChange(
    tx,
    "chapter",
    renumbered.flatMap((c) => JSON.parse(c.chapters) as string[])
  );
  return refs.written;
}

// `rebuildTurns` inside the caller's transaction, which logs: the refs of the turns written and
// of those gone (a turn moved off the map: the feed says it went).
function writeTurns(
  tx: Pick<Db, "delete" | "insert" | "select" | "update">,
  jobId: string
) {
  const row = tx
    .select({
      language: transcripts.languageCode,
      map: jobs.map,
      parsed: transcripts.parsed,
      raw: transcripts.raw,
      version: transcripts.parserVersion,
    })
    .from(jobs)
    .innerJoin(transcripts, eq(transcripts.jobId, jobs.id))
    .where(eq(jobs.id, jobId))
    .get();
  if (!row) {
    return { all: [], written: 0 };
  }
  let { parsed } = row;
  if (row.version < PARSER_VERSION) {
    parsed = { ...parsed, words: parseTranscript(row.raw).transcript.words };
    tx.update(transcripts)
      .set({ parsed, parserVersion: PARSER_VERSION })
      .where(eq(transcripts.jobId, jobId))
      .run();
  }
  const rows = row.map ? buildTurns(parsed, row.language, row.map) : [];
  const old = tx
    .delete(turns)
    .where(eq(turns.jobId, jobId))
    .returning({ turnIndex: turns.turnIndex })
    .all();
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    tx.insert(turns)
      .values(rows.slice(i, i + INSERT_CHUNK).map((r) => ({ ...r, jobId })))
      .run();
  }
  return {
    all: [
      ...new Set([...old, ...rows].map((r) => turnRef(jobId, r.turnIndex))),
    ],
    written: rows.length,
  };
}

// The live conversations where the job's turns start before another job's turn: audio that came
// late or out of order (the phone sends newest first).
const landedEarlier = (tx: Pick<Db, "all">, jobId: string) =>
  tx.all<{
    // A JSON array of ids.
    chapters: string;
    end: number;
    id: string;
    start: number;
  }>(sql`
    select c.id, c.capture_started_at as start, c.capture_ended_at as end,
      (select json_group_array(h.id) from chapters h where h.conversation_id = c.id) as chapters
    from (select c.*, (select min(t.start_at) from turns t where t.job_id = ${jobId}
        and ${holdsTurn()}) as first
      from conversations c where c.retired_at is null) c
    where c.first is not null
      and exists (select 1 from turns o where o.job_id <> ${jobId}
        and o.start_at > c.first and o.start_at < c.capture_ended_at)`);
