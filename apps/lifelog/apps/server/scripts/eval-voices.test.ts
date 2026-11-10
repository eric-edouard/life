import { expect, test } from "bun:test";
import { type Export, evaluate } from "./eval-voices";

// Made-up voices: his along x, Pat's along y, a stranger's along z.
const HIM = [1, 0, 0];
const PAT = [0, 1, 0];
const STRANGER = [0, 0, 1];
type Sample = Export["samples"][number];
const sample = (
  id: string,
  conversation: string,
  speakerLabel: string,
  turnIndex: number,
  embedding: number[],
  job = conversation
): Sample => ({
  conversationId: conversation,
  durationSeconds: 5,
  embedding,
  id,
  jobId: `job-${job}`,
  modelId: "ecapa",
  modelRevision: "1",
  speakerLabel,
  turnIndex,
});
// A sample as evidence for a person, as people.ts `evidenceRows` reads it.
const evidence = (s: Sample, personId: string) => ({
  ...s,
  isOwner: personId === "me",
  personId,
  sampleId: s.id,
});
const answer = (
  conversation: string,
  speakerLabel: string,
  turnIndex: number | null,
  personId: string | null,
  several = false
) => ({
  candidates: several ? { people: ["me", "pat"], unknown: false } : null,
  jobId: `job-${conversation}`,
  personId,
  speakerLabel,
  status: personId ? ("person" as const) : ("unknown" as const),
  turnIndex,
});
// His and Pat's clips in conversation a; other conversations are judged.
const a = [
  sample("a0", "a", "s0", 0, HIM),
  sample("a1", "a", "s0", 1, HIM),
  sample("a2", "a", "s1", 2, PAT),
  sample("a3", "a", "s1", 3, PAT),
];
const hisEvidence = a.slice(0, 2).map((s) => evidence(s, "me"));
const patsEvidence = a.slice(2).map((s) => evidence(s, "pat"));

test("a stranger's turn inside a voice recognized as him is a false owner, and the voice counts as credited", () => {
  const data: Export = {
    assignments: [
      answer("b", "s0", null, "me"),
      answer("b", "s0", 3, null), // "Not anyone I know"
    ],
    evidence: [...hisEvidence, ...patsEvidence],
    owner: "me",
    samples: [
      ...a,
      sample("b0", "b", "s0", 0, HIM),
      sample("b1", "b", "s0", 1, HIM),
      sample("b2", "b", "s0", 2, HIM),
      sample("b3", "b", "s0", 3, STRANGER),
    ],
    strangers: [],
  };
  const { clusters, counts, insideHim, turns } = evaluate(data);
  expect(turns).toBe(4);
  expect(counts).toMatchObject({ falseOwner: 1, ownerRight: 3 });
  expect(clusters).toEqual({
    creditedWithAnother: 1,
    holdingHim: 1,
    holdingHimAndAnother: 1,
  });
  expect([insideHim.his.length, insideHim.others.length]).toEqual([3, 1]);
});

test("his turn answered inside a stranger's voice is judged by its own answer", () => {
  const data: Export = {
    assignments: [answer("b", "s0", null, null), answer("b", "s0", 3, "me")],
    evidence: hisEvidence,
    owner: "me",
    samples: [
      ...a.slice(0, 2),
      sample("b0", "b", "s0", 0, STRANGER),
      sample("b1", "b", "s0", 1, STRANGER),
      sample("b2", "b", "s0", 2, STRANGER),
      sample("b3", "b", "s0", 3, HIM),
    ],
    strangers: [],
  };
  const { clusters, counts, insideHim } = evaluate(data);
  expect(counts).toMatchObject({ nobodyRight: 3, ownerRight: 1 });
  expect(clusters.creditedWithAnother).toBe(0);
  expect(insideHim).toEqual({ his: [], others: [] });
});

test("a conversation is judged without its own evidence, and a several-people answer judges nothing", () => {
  const b = [
    sample("b0", "b", "s1", 0, PAT),
    sample("b1", "b", "s1", 1, PAT),
    sample("b2", "b", "s2", 2, PAT),
    sample("b3", "b", "s2", 3, PAT),
  ];
  const data: Export = {
    assignments: [
      answer("b", "s1", null, "pat"),
      answer("b", "s2", null, "pat", true),
      // One turn of a named voice where several people speak: no answer either.
      answer("b", "s1", 1, null, true),
    ],
    evidence: [...hisEvidence, evidence(b[0] as Sample, "pat")],
    owner: "me",
    samples: [...a.slice(0, 2), ...b],
    // Pat's only evidence is in b, the conversation judged.
    strangers: [],
  };
  const { counts, turns } = evaluate(data);
  expect(turns).toBe(1);
  expect(counts.leftUnnamed).toBe(1);
});

test("a job whose samples were cut in two conversations is judged without the evidence of either", () => {
  // Pat's only evidence is in conversation c, which job b's later samples carry.
  const x0 = sample("x0", "c", "s0", 0, PAT, "x");
  const data: Export = {
    assignments: [answer("b", "s1", null, "pat")],
    evidence: [...hisEvidence, evidence(x0, "pat")],
    owner: "me",
    samples: [
      ...a.slice(0, 2),
      x0,
      sample("b0", "b", "s1", 0, PAT),
      sample("b1", "b", "s1", 1, PAT),
      sample("b2", "c", "s1", 2, PAT, "b"),
      sample("b3", "c", "s1", 3, PAT, "b"),
    ],
    strangers: [],
  };
  expect(evaluate(data).counts.leftUnnamed).toBe(4);
});
