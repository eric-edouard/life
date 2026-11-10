import { expect, test } from "bun:test";
import { writesOf } from "./apply";
import type { BenchAnswer } from "./truth";

const turn = (speakerLabel: string, turnIndex: number) => ({
  id: `${speakerLabel}-${turnIndex}`,
  jobId: "job",
  speakerLabel,
  turnIndex,
});
const row = (
  speakerLabel: string,
  turnIndex: number | null,
  personId: string | null
) => ({
  candidates: null,
  jobId: "job",
  personId,
  speakerLabel,
  status: personId ? ("person" as const) : ("unknown" as const),
  turnIndex,
});
const answered = (answers: Record<string, Partial<BenchAnswer>>) =>
  new Map(
    Object.entries(answers).map(([id, a]) => [
      id,
      { at: "", id, kind: "person", ...a } as BenchAnswer,
    ])
  );

test("his bench answers become the fewest writes, and none once the archive holds them", () => {
  // s1: both turns are Bo, not Ana. s2: one of its two turns is Bo. s3 has a turn he never heard.
  const turns = [turn("s1", 0), turn("s1", 1), turn("s2", 2), turn("s3", 4)];
  const samples = [...turns, turn("s2", 3), turn("s3", 5)];
  const answers = answered({
    "s1-0": { personId: "bo" },
    "s1-1": { personId: "bo" },
    "s2-2": { personId: "bo" },
    "s3-4": { kind: "several" },
  });
  const people = new Set(["ana", "bo"]);
  const before = [row("s1", null, "ana"), row("s1", 1, "bo")];
  const { writes } = writesOf(
    turns,
    answers,
    { assignments: before, samples },
    people
  );
  expect(writes).toEqual([
    { jobId: "job", kind: "person", personId: "bo", speakerLabel: "s1" },
    {
      jobId: "job",
      kind: "person",
      personId: "bo",
      speakerLabel: "s2",
      turnIndex: 2,
    },
    { jobId: "job", kind: "several", speakerLabel: "s3", turnIndex: 4 },
  ]);
  const after = [
    row("s1", null, "bo"),
    row("s1", 1, "bo"),
    row("s2", 2, "bo"),
    { ...row("s3", 4, null), candidates: { people: [], unknown: true } },
  ];
  expect(
    writesOf(turns, answers, { assignments: after, samples }, people).writes
  ).toEqual([]);
  // A person the archive no longer has, or one left out for now, is left, never written.
  expect(
    writesOf(turns, answers, { assignments: before, samples }, people, ["bo"])
  ).toEqual({
    left: 3,
    writes: [
      { jobId: "job", kind: "several", speakerLabel: "s3", turnIndex: 4 },
    ],
  });
});
