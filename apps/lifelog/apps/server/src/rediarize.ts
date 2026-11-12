// Who spoke when in a stored speech-service transcript, redone from the speech service's corrected
// turns (the turns follow the speaker who has the floor, docs/decisions.md, 13 Nov 2026): the owner's
// one-off. The words, turns and turn indexes stay; only the speaker labels change. Each stored turn
// takes the new turn holding most of its seconds, and one map (each old label to the new label holding most of
// its seconds) moves every row keyed by label: owner answers, recognized names, voice samples and
// the summary runs' speaker guesses. Recognition then matches the new voices again from the samples.
import { randomUUID } from "node:crypto";
import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  speakerAssignments as assignments,
  intelligenceRuns,
  transcriptionJobs as jobs,
  type ParsedTranscript,
  transcripts,
  voiceSamples,
} from "@lifelog/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { logChange } from "./change-log";
import { evidenceFromAnswer, holdingConversations, recognize } from "./people";
import { turnAt } from "./route-turns";
import { ownWords } from "./transcript";
import { rebuildTurnsIn } from "./turns";

export interface DiarizedTurn {
  end: number;
  speaker: string;
  start: number;
}

type Assignment = typeof assignments.$inferSelect;

const overlap = (a: { end: number; start: number }, b: DiarizedTurn) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const most = (seconds: Map<string, number>) =>
  [...seconds].sort((a, b) => b[1] - a[1])[0]?.[0];
const add = (seconds: Map<string, number>, key: string, s: number) =>
  seconds.set(key, (seconds.get(key) ?? 0) + s);

// Each stored turn's new label, numbered as the speech service numbers its own (route-turns.ts).
export function labelsOf(parsed: ParsedTranscript, diarized: DiarizedTurn[]) {
  const order = [...diarized].sort((a, b) => a.start - b.start);
  const speakers = [...new Set(order.map((t) => t.speaker))];
  return parsed.turns.map((turn) => {
    const held = new Map<string, number>();
    for (const d of order) {
      add(held, d.speaker, overlap(turn, d));
    }
    const speaker =
      most(new Map([...held].filter(([, s]) => s > 0))) ??
      turnAt(order, (turn.start + turn.end) / 2)?.speaker;
    return `speaker_${speakers.indexOf(speaker ?? "")}`;
  });
}

// Each old label's new label: the one holding most of its seconds.
export function labelMapOf(parsed: ParsedTranscript, labels: string[]) {
  const seconds = new Map<string, Map<string, number>>();
  parsed.turns.forEach((turn, i) => {
    const old = turn.speakerId;
    const next = labels[i];
    if (old && next) {
      const held = seconds.get(old) ?? new Map<string, number>();
      add(held, next, turn.end - turn.start);
      seconds.set(old, held);
    }
  });
  return new Map([...seconds].map(([old, held]) => [old, most(held) ?? old]));
}

// The transcript with its new labels: each turn, the words it owns (`ownWords`) and, so a parser
// bump re-reads the same speakers, the provider's tokens in `raw`.
export function relabeled(
  parsed: ParsedTranscript,
  raw: { words?: Record<string, unknown>[] },
  labels: string[],
  map: Map<string, string>
) {
  const labelOf = (speakerId: string | null, start: number, end: number) => {
    const i = parsed.turns.findIndex(
      (t) =>
        ownWords(t, [
          { end, logprob: null, spacing: "", speakerId, start, text: "" },
        ]).length > 0
    );
    return i >= 0 ? labels[i] : speakerId && (map.get(speakerId) ?? speakerId);
  };
  return {
    parsed: {
      ...parsed,
      turns: parsed.turns.map((t, i) => ({
        ...t,
        speakerId: labels[i] ?? t.speakerId,
      })),
      words: parsed.words.map((w) => ({
        ...w,
        speakerId: labelOf(w.speakerId, w.start, w.end) ?? null,
      })),
    },
    raw: {
      ...raw,
      words: (raw.words ?? []).map((token) => {
        const { speaker_id: speaker, start } = token;
        if (typeof speaker !== "string" || typeof start !== "number") {
          return token;
        }
        const end = typeof token.end === "number" ? token.end : start;
        return { ...token, speaker_id: labelOf(speaker, start, end) };
      }),
    },
  };
}

// The job's assignment rows under the new labels. A turn's row keeps its turn. A whole voice's
// owner answer stays whole on its new label when every turn there came from that voice; otherwise
// it answers, turn by turn, its own turns that landed there. Turns that left the voice get no
// answer: that is the split. A "several people" answer or a mixed mark moves whole, for recognition
// to decide again. A recognized name moves by the map, the one from the voice with most turns
// there; recognition redoes those after.
export function movedRows(
  rows: Assignment[],
  oldLabels: (string | null)[],
  labels: string[],
  map: Map<string, string>
) {
  const now = clock();
  const out = new Map<string, Assignment>();
  const key = (label: string, turn: number | null) => `${label}|${turn ?? -1}`;
  const put = (row: Assignment) => {
    const k = key(row.speakerLabel, row.turnIndex);
    if (!out.has(k)) {
      out.set(k, row);
    }
  };
  const held = (r: Assignment) => r.source === "owner" || r.mixed;
  const turnsOf = (old: string, next: string) =>
    labels.flatMap((l, i) => (l === next && oldLabels[i] === old ? [i] : []));
  // Most specific first, so a turn's own answer wins over a voice's.
  for (const r of rows.filter((x) => x.turnIndex !== null && held(x))) {
    put({
      ...r,
      speakerLabel: labels[r.turnIndex ?? 0] ?? r.speakerLabel,
      updatedAt: now,
    });
  }
  for (const r of rows.filter((x) => x.turnIndex === null && held(x))) {
    const next = map.get(r.speakerLabel);
    if (!next) {
      continue;
    }
    const clean = labels.every(
      (l, i) => l !== next || oldLabels[i] === r.speakerLabel
    );
    if (clean || r.candidates || r.mixed) {
      put({ ...r, speakerLabel: next, updatedAt: now });
      continue;
    }
    for (const turnIndex of turnsOf(r.speakerLabel, next)) {
      put({
        ...r,
        id: randomUUID(),
        speakerLabel: next,
        turnIndex,
        updatedAt: now,
      });
    }
  }
  for (const r of rows.filter((x) => x.turnIndex !== null && !held(x))) {
    put({
      ...r,
      speakerLabel: labels[r.turnIndex ?? 0] ?? r.speakerLabel,
      updatedAt: now,
    });
  }
  const turnCount = (old: string, next: string) => turnsOf(old, next).length;
  const recognized = rows
    .filter((r) => r.turnIndex === null && !held(r) && map.has(r.speakerLabel))
    .sort((a, b) => {
      const na = map.get(a.speakerLabel) ?? "";
      const nb = map.get(b.speakerLabel) ?? "";
      return turnCount(b.speakerLabel, nb) - turnCount(a.speakerLabel, na);
    });
  for (const r of recognized) {
    put({
      ...r,
      speakerLabel: map.get(r.speakerLabel) ?? r.speakerLabel,
      updatedAt: now,
    });
  }
  return [...out.values()];
}

export type Rediarized = "done" | "unchanged" | "refused";

// Applies the corrected turns to one completed speech job. Refused for another job or no turns;
// unchanged when its labels already are these.
export function rediarize(
  db: Db,
  jobId: string,
  diarized: DiarizedTurn[]
): Rediarized {
  const outcome = db.transaction((tx) => {
    const row = tx
      .select({ parsed: transcripts.parsed, raw: transcripts.raw })
      .from(transcripts)
      .innerJoin(jobs, eq(jobs.id, transcripts.jobId))
      .where(
        and(
          eq(transcripts.jobId, jobId),
          eq(jobs.transcriber, "speech"),
          eq(jobs.state, "completed")
        )
      )
      .get();
    if (!row || diarized.length === 0) {
      return "refused" as const;
    }
    const oldLabels = row.parsed.turns.map((t) => t.speakerId);
    const labels = labelsOf(row.parsed, diarized);
    if (labels.every((l, i) => l === oldLabels[i])) {
      return "unchanged" as const;
    }
    const map = labelMapOf(row.parsed, labels);
    const next = relabeled(
      row.parsed,
      row.raw as { words?: Record<string, unknown>[] },
      labels,
      map
    );
    tx.update(transcripts).set(next).where(eq(transcripts.jobId, jobId)).run();
    rebuildTurnsIn(tx, jobId);
    const rows = tx
      .select()
      .from(assignments)
      .where(eq(assignments.jobId, jobId))
      .all();
    tx.delete(assignments).where(eq(assignments.jobId, jobId)).run();
    const moved = movedRows(rows, oldLabels, labels, map);
    if (moved.length > 0) {
      tx.insert(assignments).values(moved).run();
    }
    // A sample takes its turn's new label, and is evidence only of what the moved answers now say.
    for (const sample of tx
      .select()
      .from(voiceSamples)
      .where(eq(voiceSamples.jobId, jobId))
      .all()) {
      const speakerLabel = labels[sample.turnIndex] ?? sample.speakerLabel;
      tx.update(voiceSamples)
        .set({ speakerLabel })
        .where(eq(voiceSamples.id, sample.id))
        .run();
      evidenceFromAnswer(tx, { ...sample, speakerLabel });
    }
    // The summary runs' guesses of who an unnamed voice is, and its tokens, follow their voice.
    const moveLabel = <T extends { jobId: string; speakerLabel: string }>(
      s: T
    ) =>
      s.jobId === jobId
        ? { ...s, speakerLabel: map.get(s.speakerLabel) ?? s.speakerLabel }
        : s;
    const conversations = holdingConversations(tx, jobId);
    for (const run of tx
      .select({ id: intelligenceRuns.id, result: intelligenceRuns.result })
      .from(intelligenceRuns)
      .where(inArray(intelligenceRuns.conversationId, conversations))
      .all()) {
      const result = run.result as {
        speakerIdentities?: { jobId: string; speakerLabel: string }[];
        speakerTokens?: { jobId: string; speakerLabel: string }[];
      } | null;
      if (!(result?.speakerIdentities || result?.speakerTokens)) {
        continue;
      }
      tx.update(intelligenceRuns)
        .set({
          result: {
            ...result,
            ...(result.speakerIdentities && {
              speakerIdentities: result.speakerIdentities.map(moveLabel),
            }),
            ...(result.speakerTokens && {
              speakerTokens: result.speakerTokens.map(moveLabel),
            }),
          },
        })
        .where(eq(intelligenceRuns.id, run.id))
        .run();
    }
    logChange(tx, "job", jobId);
    logChange(tx, "assignment", jobId);
    return "done" as const;
  });
  if (outcome === "done") {
    recognize(db, jobId);
  }
  return outcome;
}
