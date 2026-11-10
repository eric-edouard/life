import { expect, test } from "bun:test";
import { send, writesOf } from "./apply";
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
    writesOf(turns, answers, { assignments: before, samples }, new Set()).left
  ).toBe(3);
  // A turn whose sample is gone from the archive is left alone.
  expect(
    writesOf(turns, answers, { assignments: before, samples: [] }, people)
      .writes
  ).toEqual([]);
  expect(
    writesOf(turns, answers, { assignments: before, samples }, people, ["bo"])
  ).toEqual({
    left: 3,
    writes: [
      { jobId: "job", kind: "several", speakerLabel: "s3", turnIndex: 4 },
    ],
  });
});

test("a write is the owner's correction on the server's route: a whole speaker carries no turn", async () => {
  const fetched = globalThis.fetch;
  const seen: [string, RequestInit][] = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    seen.push([url, init]);
    return Promise.resolve(new Response("[]", { status: 404 }));
  }) as unknown as typeof fetch;
  try {
    const status = await send("http://127.0.0.1:1", "t", {
      jobId: "job",
      kind: "several",
      speakerLabel: "speaker 1",
    });
    expect(status).toBe(404);
    expect(seen[0]?.[0]).toBe(
      "http://127.0.0.1:1/transcripts/job/speakers/speaker%201"
    );
    expect(JSON.parse(String(seen[0]?.[1].body))).toEqual({
      target: { kind: "several", people: [], unknown: true },
    });
  } finally {
    globalThis.fetch = fetched;
  }
});
