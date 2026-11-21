import { expect, test } from "bun:test";
import { Person } from "../records/truth";
import { checksOf } from "./checks";
import { about, inputs } from "./checks-test-inputs";
import { inferred, said } from "./record-fixtures";
import {
  samePersonPairOf,
  samePersonPairsOf,
  samePersonRefOf,
} from "./same-person";
import { foldsOf } from "./who";

// The likely matches, made-up people: a guess with a handle and someone else going by its whole name.

const LINE = "@line__u1:beeper.local";
const kit = { ...inferred("inf_kit", [LINE, "+33600000001"]), name: "Kit Lee" };
const cousin = Person.parse({
  id: "kit-lee",
  name: "Kit Lee",
  relation: "his cousin",
});
const pairsOf = (
  over: {
    contacts?: { card: string; handles: string[]; id: string; name: string }[];
    corrections?: ReturnType<typeof said>[];
    directory?: Person[];
    guesses?: (typeof kit)[];
    isGuess?: (ref: string) => boolean;
  } = {}
) => {
  const directory = over.directory ?? [cousin];
  const guesses = over.guesses ?? [kit];
  const corrections = over.corrections ?? [];
  const contacts = over.contacts ?? [];
  const folds = foldsOf(directory, guesses, corrections, contacts);
  return samePersonPairsOf({
    ...folds,
    contacts,
    corrections,
    inferred: guesses,
    isGuess: over.isGuess ?? ((r) => r.startsWith("person:inf_")),
    isOrganization: () => false,
    relationOf: () => null,
    truth: { people: directory } as never,
  }).map(({ guess, other }) => `${guess} ~ ${other}`);
};

test("a guess Life uses and someone in his directory going by its whole name make one pair, bound to both in its ref", () => {
  expect(pairsOf()).toEqual(["person:inf_kit ~ person:kit-lee"]);
  // A name with a particle is still a name.
  const anna = Person.parse({ id: "anna", name: "Anna de Vries" });
  expect(
    pairsOf({ directory: [anna], guesses: [{ ...kit, name: "Anna de Vries" }] })
  ).toEqual(["person:inf_kit ~ person:anna"]);
  expect(
    samePersonPairOf(samePersonRefOf("person:inf_kit", "person:kit-lee"))
  ).toEqual({
    guess: "person:inf_kit",
    other: "person:kit-lee",
  });
});

test("never asked: one name, a guess with no handle, a guess Life is sure of, a fold, a pair he answered either way or by a handle written another way", () => {
  const jp = Person.parse({ id: "jp", name: "Jean-Pierre" });
  expect(
    pairsOf({ directory: [jp], guesses: [{ ...kit, name: "Jean-Pierre" }] })
  ).toEqual([]);
  expect(
    pairsOf({ guesses: [{ ...kit, namesAndHandles: ["Kit Lee"] }] })
  ).toEqual([]);
  expect(pairsOf({ isGuess: () => false })).toEqual([]);
  // A description is no name: two guesses described alike are not asked about.
  const plumber = { ...kit, name: "the shop plumber" };
  const plumber2 = {
    ...inferred("inf_p2", ["+33600000005"]),
    name: "the shop plumber",
  };
  expect(pairsOf({ directory: [], guesses: [plumber, plumber2] })).toEqual([]);
  // His "No" on the guess's only handle, then his "Different people": the handle reads as no one, never asked again.
  const one = { ...kit, namesAndHandles: ["+33600000001"] };
  expect(
    pairsOf({
      corrections: [
        said({
          kind: "not-this-person",
          nameOrHandle: "+33600000001",
          person: "person:inf_kit",
        }),
        said({
          kind: "not-this-person",
          nameOrHandle: "+33600000001",
          person: "person:kit-lee",
        }),
      ],
      guesses: [one],
    })
  ).toEqual([]);
  expect(
    pairsOf({
      corrections: [
        said({
          from: "person:inf_kit",
          kind: "same-person",
          to: "person:kit-lee",
        }),
      ],
    })
  ).toEqual([]);
  const no = (nameOrHandle: string, person: string) =>
    said({ kind: "not-this-person", nameOrHandle, person });
  // His "Different people" on a handle, and on the phone written another way.
  expect(pairsOf({ corrections: [no(LINE, "person:kit-lee")] })).toEqual([]);
  expect(
    pairsOf({ corrections: [no("+33 6 00 00 00 01", "person:kit-lee")] })
  ).toEqual([]);
  // Two guesses: refused on the other one's handle, and after the refused one folded into a third.
  const twin = { ...inferred("inf_kit-2", ["+33600000002"]), name: "Kit Lee" };
  expect(
    pairsOf({
      corrections: [no("+33600000002", "person:inf_kit")],
      directory: [],
      guesses: [kit, twin],
    })
  ).toEqual([]);
  const third = { ...inferred("inf_kit-3", ["+33600000003"]), name: "Kit Lee" };
  const folded = pairsOf({
    corrections: [
      no(LINE, "person:inf_kit-2"),
      said({
        from: "person:inf_kit",
        kind: "same-person",
        to: "person:inf_kit-3",
      }),
    ],
    directory: [],
    guesses: [kit, twin, third],
  });
  expect(folded).toEqual([]);
});

test("two guesses going by one whole name are one card whichever comes first, asked of the smaller id; a native handle counts; a Contacts card counts too", () => {
  const twin = { ...inferred("inf_kit-2", ["_u91_abc"]), name: "Kit Lee" };
  expect(pairsOf({ directory: [], guesses: [twin, kit] })).toEqual([
    "person:inf_kit ~ person:inf_kit-2",
  ]);
  expect(
    pairsOf({
      directory: [],
      guesses: [{ ...kit, namesAndHandles: ["Kit Lee"] }, twin],
    })
  ).toEqual(["person:inf_kit-2 ~ person:inf_kit"]);
  expect(
    pairsOf({
      contacts: [
        {
          card: "c1",
          handles: ["+33600000009"],
          id: "con_kit",
          name: "Kit Lee",
        },
      ],
      directory: [],
    })
  ).toEqual(["person:inf_kit ~ person:con_kit"]);
});

test("a guess and someone going by its whole name are asked once, bound to both, and only while a kept line rides on the guess", () => {
  const pair = {
    guess: "person:inf_a",
    handles: ["+33600000001"],
    lines: ["the plumber, +33600000001", "his cousin"] as [string, string],
    other: "person:dana",
  };
  const asked = checksOf(
    inputs([about("person:inf_a")], { samePersons: [pair] })
  ).filter((x) => x.group === "same person");
  expect(
    asked.map((x) => [x.ref, x.about, x.options.map((o) => o.id)])
  ).toEqual([
    [
      samePersonRefOf("person:inf_a", "person:dana"),
      ["+33600000001"],
      ["same-person", "not-this-person"],
    ],
  ]);
  expect(asked[0]?.question).toBe(
    "Is person:inf_a (the plumber, +33600000001) the same person as Dana (his cousin)?"
  );
  expect(
    checksOf(inputs([about("person:x")], { samePersons: [pair] })).filter(
      (x) => x.group === "same person"
    )
  ).toEqual([]);
});
