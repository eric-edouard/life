import type { speakerAssignments } from "@lifelog/db/schema";
import type { decide } from "./speakers";

type Assignment = typeof speakerAssignments.$inferSelect;
export type Recognition = ReturnType<typeof decide> & {
  candidateId: string | null;
  label: string;
  model: string | null;
  turnIndices?: number[];
};

// A speaker whose voice data expired: what it was last recognized as.
export const lastKnown = (old: Assignment): Recognition => ({
  candidateId: old.candidateId,
  isStranger: old.status === "stranger",
  label: old.speakerLabel,
  margin: old.margin,
  model: null,
  personId: old.personId,
  score: old.score,
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
      old.status === statusOf(r)
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
        jobId,
        margin: r.margin,
        personId: r.personId,
        score: r.score,
        source: "recognized" as const,
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
  return r.candidateId && !r.turnIndices
    ? ("candidate" as const)
    : ("unknown" as const);
};
