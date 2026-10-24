import { expect, test } from "bun:test";
import { decide, type Profile } from "./speakers";

const profiles: Profile[] = [
  { isOwner: true, personId: "owner", vector: [1, 0, 0] },
  { isOwner: false, personId: "clara", vector: [0, 1, 0] },
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

test("a short turn is the owner's at 0.4 only with a 0.1 lead; a long one still needs 0.5", () => {
  expect(owned(turnAt(0.45, 0.25, 3))).toEqual(["owner"]);
  expect(owned(turnAt(0.45, 0.41, 3))).toEqual([]);
  expect(owned(turnAt(0.45, 0.25, 10))).toEqual([]);
  expect(owned(turnAt(0.55, 0.5, 10))).toEqual(["owner"]);
});
