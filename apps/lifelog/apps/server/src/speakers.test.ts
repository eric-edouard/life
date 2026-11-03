import { expect, test } from "bun:test";
import { decide, likeness, type Profile } from "./speakers";

const profiles: Profile[] = [
  { exemplars: [[1, 0, 0]], isOwner: true, personId: "owner" },
  { exemplars: [[0, 1, 0]], isOwner: false, personId: "clara" },
];

// A turn's sample at `owner` to his profile and `other` to Clara's.
const turnAt = (owner: number, other: number, durationSeconds: number) => ({
  durationSeconds,
  embedding: [owner, other, Math.sqrt(1 - owner ** 2 - other ** 2)],
  turnIndex: 0,
});
const owned = (sample: ReturnType<typeof turnAt>) =>
  decide({ samples: [sample], vector: null }, profiles).turns.map(
    (t) => t.personId
  );

test("a short turn is the owner's at 0.5 only with a 0.1 lead; a long one still needs 0.6", () => {
  expect(owned(turnAt(0.55, 0.35, 3))).toEqual(["owner"]);
  expect(owned(turnAt(0.55, 0.5, 3))).toEqual([]);
  expect(owned(turnAt(0.55, 0.35, 10))).toEqual([]);
  expect(owned(turnAt(0.65, 0.6, 10))).toEqual(["owner"]);
});

test("a voice is as like a person as its two closest conversations of theirs", () => {
  const exemplars = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  expect(likeness([0.8, 0.6, 0], exemplars)).toBeCloseTo(0.7);
  expect(likeness([0.8, 0.6, 0], [[1, 0, 0]])).toBeCloseTo(0.8);
});
