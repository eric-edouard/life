import { expect, test } from "bun:test";
import {
  decide,
  likeness,
  nearbyMatch,
  type Profile,
  rankPeople,
} from "./speakers";

const profiles: Profile[] = [
  {
    conversations: ["reference"],
    exemplars: [[1, 0, 0]],
    isOwner: true,
    personId: "owner",
  },
  {
    conversations: ["reference"],
    exemplars: [[0, 1, 0]],
    isOwner: false,
    personId: "clara",
  },
];

// A turn's sample at `owner` to his profile and `other` to Clara's.
const turnAt = (owner: number, other: number, durationSeconds: number) => ({
  durationSeconds,
  embedding: [owner, other, Math.sqrt(1 - owner ** 2 - other ** 2)],
  turnIndex: 0,
});
const owned = (sample: ReturnType<typeof turnAt>) =>
  decide(
    { samples: [sample], vector: null },
    { people: profiles, strangerConversations: [], strangers: [] }
  ).turns.map((t) => t.personId);

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

test("a turn that sounds more like a stranger than the owner stays put, unless he named who is there", () => {
  const sample = turnAt(0.62, 0, 10); // 0.79 to the stranger below
  const voices = {
    people: profiles,
    strangerConversations: ["reference"],
    strangers: [[0, 0, 1]],
  };
  const moved = (candidates: { people: string[]; unknown: boolean } | null) =>
    decide({ samples: [sample], vector: null }, voices, candidates).turns.map(
      (t) => t.personId
    );
  expect(owned(sample)).toEqual(["owner"]);
  expect(moved(null)).toEqual([]);
  expect(moved({ people: ["owner"], unknown: false })).toEqual([]);
  expect(moved({ people: ["owner", "clara"], unknown: false })).toEqual([
    "owner",
  ]);
});

test("a new voice unlike everyone is no stranger, however little it sounds like the people", () => {
  const voices = {
    people: profiles,
    strangerConversations: ["reference"],
    strangers: [[0, 0, 1]],
  };
  const isStranger = (vector: number[]) =>
    decide({ samples: [], vector }, voices).isStranger;
  // 0.30 to the owner, 0.50 to the stranger: ahead, but not as alike as one group's voices.
  expect(isStranger([0.3, 0.2, 0.5, Math.sqrt(0.62)])).toBe(false);
  expect(isStranger([0.3, 0.2, 0.7, Math.sqrt(0.38)])).toBe(true);
});

test("a lone profile competes with the match threshold in every margin check", () => {
  const [, person] = profiles;
  if (!person) {
    throw new Error("missing profile");
  }
  const voices = { people: [person], strangerConversations: [], strangers: [] };
  const named = (score: number) =>
    decide(
      { samples: [], vector: [Math.sqrt(1 - score ** 2), score, 0] },
      voices
    ).personId;
  expect(named(0.55)).toBeNull();
  expect(named(0.65)).toBeNull();
  const vector = [0, 0.65, Math.sqrt(1 - 0.65 ** 2)];
  expect(rankPeople(vector, [person])[0]?.margin).toBeCloseTo(0.05);
  expect(nearbyMatch(vector, [person], new Set(["clara"]))).toBeNull();
  expect(
    decide(
      {
        samples: [{ durationSeconds: 3, embedding: vector, turnIndex: 0 }],
        vector: null,
      },
      voices,
      { people: ["clara"], unknown: true }
    ).turns[0]?.personId
  ).toBeUndefined();
  expect(named(0.75)).toBe("clara");
  expect(nearbyMatch([0, 0.8, 0.6], [person], new Set(["clara"]))).toBe(
    "clara"
  );
  const sample = turnAt(0, 0.5, 10);
  expect(
    decide({ samples: [sample], vector: null }, voices, {
      people: ["clara"],
      unknown: false,
    }).turns.map((t) => t.personId)
  ).toEqual([]);
});

test("a lone owner still takes 0.65 through ownerTurn, but not 0.55 through its short-turn margin", () => {
  const owner: Profile = {
    conversations: ["reference"],
    exemplars: [[1, 0, 0]],
    isOwner: true,
    personId: "owner",
  };
  const sample = turnAt(0.65, 0, 3);
  expect(
    decide(
      { samples: [sample], vector: null },
      { people: [owner], strangerConversations: [], strangers: [] }
    ).turns
  ).toEqual([{ personId: "owner", score: 0.65, turnIndex: 0 }]);
  // Below ownerTurn: this specifically exercises the lone-profile margin convention.
  expect(
    decide(
      { samples: [turnAt(0.55, 0, 3)], vector: null },
      { people: [owner], strangerConversations: [], strangers: [] }
    ).turns[0]?.personId
  ).toBeUndefined();
});

test("a voice under 8 s is named at 0.5 and a 0.2 lead, a person only", () => {
  const voices = { people: profiles, strangerConversations: [], strangers: [] };
  const short = (owner: number, other: number, strangers: number[][] = []) =>
    decide(
      { samples: [turnAt(owner, other, 3)], vector: null },
      { ...voices, strangers }
    );
  const clara = short(0.2, 0.6);
  expect(clara.personId).toBe("clara");
  expect(clara.vector).toBeNull();
  expect(short(0.5, 0.45).personId).toBeNull(); // close between two people
  // 0.78 to the stranger below: stays unnamed, and is not marked a stranger
  const unlike = short(0.2, 0.55, [[0, 0, 1]]);
  expect(unlike.personId).toBeNull();
  expect(unlike.isStranger).toBe(false);
});
