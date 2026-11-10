import type { Db } from "@lifelog/db";
import type { speakerAssignments } from "@lifelog/db/schema";
import {
  speakerAssignments as assignments,
  conversationJobs,
  transcripts,
  voiceSamples,
} from "@lifelog/db/schema";
import { and, type Column, eq, isNull, or, sql } from "drizzle-orm";
import { turnRef } from "./change-log";
import type { NamingInput, ScopeReading } from "./inferred-speakers";
import {
  type decide,
  decideInferredName,
  type NamingCalibration,
  type Profiles,
} from "./speakers";

type Assignment = typeof speakerAssignments.$inferSelect;
export type Recognition = ReturnType<typeof decide> & {
  candidateId: string | null;
  label: string;
  model: string | null;
  inference?: Assignment["inference"];
  source?: Assignment["source"];
  turnIndices?: number[];
};

// A speaker whose voice data expired: what it was last recognized as.
export const lastKnown = (old: Assignment): Recognition => ({
  candidateId: old.candidateId,
  inference: old.inference,
  isStranger: old.status === "stranger",
  label: old.speakerLabel,
  margin: old.margin,
  model: null,
  personId: old.personId,
  score: old.score,
  source: old.source,
  turns: [],
  vector: null,
});

// Whether `results` say what the stored rows already say (scores aside).
export const unchanged = (
  results: Recognition[],
  before: Map<string, Assignment>
) =>
  results.length === before.size &&
  results.every((r) => {
    const old = r.turnIndices ? undefined : before.get(r.label);
    return (
      r.turns.length === 0 &&
      old?.personId === r.personId &&
      old.candidateId === groupOf(r) &&
      old.status === statusOf(r) &&
      old.source === (r.source ?? "recognized") &&
      JSON.stringify(old.inference) === JSON.stringify(r.inference ?? null)
    );
  });

// A speaker that is the owner needs none of his turns moved.
export function keepOwnerWhole(
  results: Recognition[],
  ownerId: string | undefined
) {
  for (const r of results) {
    if (r.personId && r.personId === ownerId) {
      r.turns = [];
    }
  }
}

// The rows recognition writes for one transcript: a row per speaker, the turns found before
// (`kept`, as they were) and those found now, in its speakers and its `several` voices.
export function recognizedRows(
  jobId: string,
  results: Recognition[],
  kept: Assignment[],
  several: Pick<Recognition, "label" | "turns">[]
) {
  return [
    ...results.flatMap((r) =>
      (r.turnIndices ?? [null]).map((turnIndex) => ({
        candidateId: groupOf(r),
        inference: r.inference ?? null,
        jobId,
        margin: r.margin,
        personId: r.personId,
        score: r.score,
        source: r.source ?? "recognized",
        speakerLabel: r.label,
        status: statusOf(r),
        turnIndex,
      }))
    ),
    ...kept.map(({ id: _, updatedAt: __, ...r }) => r),
    ...[...results, ...several].flatMap((r) =>
      r.turns.map((t) => ({
        jobId,
        personId: t.personId,
        score: t.score,
        source: "recognized" as const,
        speakerLabel: r.label,
        status: "person" as const,
        turnIndex: t.turnIndex,
      }))
    ),
  ];
}

// A named voice or a stranger is in no unnamed group.
const groupOf = (r: Recognition) =>
  r.personId || r.isStranger ? null : r.candidateId;

const statusOf = (r: Recognition) => {
  if (r.personId) {
    return "person" as const;
  }
  if (r.isStranger) {
    return "stranger" as const;
  }
  return r.candidateId ? ("candidate" as const) : ("unknown" as const);
};

// One job's speaker label: the same voice id in the queue, fetch and assign_speaker.
export const voiceId = (jobId: string, label: string | null) =>
  `${jobId}/${label ?? ""}`;

export const modelKey = (
  s: Pick<typeof voiceSamples.$inferSelect, "modelId" | "modelRevision">
) => `${s.modelId}@${s.modelRevision}`;

// A job's transcript, null before it has one.
export const loadTranscript = (db: Db, jobId: string) =>
  db
    .select({ parsed: transcripts.parsed })
    .from(transcripts)
    .where(eq(transcripts.jobId, jobId))
    .get() ?? null;

// The live conversations that hold the job (`conversation_jobs`; a job over a boundary is in two),
// none while it waits for grouping. Read by the view's own `where`, so SQLite seeks the job's
// turns; a join on the view builds all of it (70 ms a call on a month's archive).
export const holdingConversations = (db: Db, jobId: string) =>
  db
    .select({ id: conversationJobs.conversationId })
    .from(conversationJobs)
    .where(eq(conversationJobs.jobId, jobId))
    .all()
    .map((c) => c.id);

// Turns with their own row belong to that row, never to their label's voice; SQL form: ofItsSpeaker.
export const readOwnTurns = (
  db: Db,
  rows = db.select().from(assignments).all()
) =>
  new Set(
    rows.flatMap((r) =>
      r.turnIndex === null ? [] : [turnRef(r.jobId, r.turnIndex)]
    )
  );

// Same rule as readOwnTurns; explicit identifiers keep SELECT from stripping the outer table.
export const ofItsSpeaker = (
  job: Column,
  turn: Column
) => sql<boolean>`not exists (select 1 from ${assignments} t
  where t.job_id = ${job.table}.${sql.identifier(job.name)}
  and t.turn_index = ${turn.table}.${sql.identifier(turn.name)})`;

export const speakerSample = ofItsSpeaker(
  voiceSamples.jobId,
  voiceSamples.turnIndex
);

// An assignment covers its turn, or its speaker's turns without their own row.
export const coveredByRow = and(
  eq(voiceSamples.jobId, assignments.jobId),
  eq(voiceSamples.speakerLabel, assignments.speakerLabel),
  or(
    eq(voiceSamples.turnIndex, assignments.turnIndex),
    and(isNull(assignments.turnIndex), speakerSample)
  )
);

// A reading is bound to the input re-read by the caller inside the recognition transaction.
export interface NamingReconciliation {
  attemptId: string;
  calibration: NamingCalibration | null;
  input: NamingInput;
  readings: ScopeReading[];
  resolvePerson: (id: string) => string | null;
}

export function inferredRows(
  jobId: string,
  values: (typeof assignments.$inferInsert)[],
  before: Assignment[],
  pass: NamingReconciliation,
  voiceOf: (indices: number[]) => {
    profiles: Profiles;
    result: ReturnType<typeof decide>;
  }
) {
  let rows = values;
  for (const reading of pass.readings) {
    const scope = pass.input.scopes.find((s) => s.id === reading.scopeId);
    if (!scope || scope.jobId !== jobId) {
      continue;
    }
    const { result, profiles } = voiceOf(scope.turnIndices);
    const person = decideInferredName(result, profiles, reading, {
      calibration: pass.calibration,
      candidates: scope.candidates,
      hasOnlyCleanRemainingTurns: scope.clean,
      ownerId: profiles.people.find((p) => p.isOwner)?.personId,
      trustedParticipants: pass.input.participants?.personIds,
    });
    if (!person) {
      continue;
    }
    const allowed = scope.turnIndices.filter((index) => {
      const fixed = speakerOf(before, scope.speakerLabel, index);
      const decided = speakerOf(rows, scope.speakerLabel, index);
      return !(
        fixed?.source === "owner" ||
        fixed?.mixed ||
        (decided?.personId && decided.source !== "inferred")
      );
    });
    if (!allowed.length) {
      continue;
    }
    const personId = result.personId ?? pass.resolvePerson(person);
    if (!personId) {
      continue;
    }
    rows = rows.filter(
      (r) =>
        !(
          r.speakerLabel === scope.speakerLabel &&
          r.turnIndex !== null &&
          r.turnIndex !== undefined &&
          allowed.includes(r.turnIndex)
        )
    );
    rows.push(
      ...allowed.map((turnIndex) => ({
        inference: result.personId
          ? null
          : {
              attemptId: pass.attemptId,
              basis: reading.basis,
              confidence: reading.confidence,
              evidence: reading.evidence.flatMap((e) => {
                const turn = pass.input.turns[e.turn];
                return turn
                  ? [
                      {
                        jobId: turn.jobId,
                        quote: e.quote,
                        turnIndex: turn.turnIndex,
                      },
                    ]
                  : [];
              }),
              inputHash: pass.input.inputHash,
              snapshotRevision: pass.input.snapshotRevision,
            },
        jobId,
        margin: result.personId ? result.margin : null,
        personId,
        score: result.personId ? result.score : null,
        source: result.personId
          ? ("recognized" as const)
          : ("inferred" as const),
        speakerLabel: scope.speakerLabel,
        status: "person" as const,
        turnIndex,
      }))
    );
  }
  return rows;
}

// One job's speaker: its turn's own row, else its label's row (turn null).
export const speakerOf = <
  R extends { speakerLabel: string; turnIndex?: number | null },
>(
  rows: R[] | undefined,
  label: string | null,
  turn: number | null
) => {
  const mine = rows?.filter((r) => r.speakerLabel === label) ?? [];
  return (
    mine.find((r) => (r.turnIndex ?? null) === turn) ??
    mine.find((r) => (r.turnIndex ?? null) === null)
  );
};
