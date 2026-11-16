import { expect, test } from "bun:test";
import type { Episode } from "../records/episode";
import { episodeGroup, episodeText, guessedOf } from "./doubts";
import { guessTestOf } from "./who";

/** This year: dates in it are said without the year. */
const YEAR = new Date().getFullYear();

test("a line rests on a guess when who it's about is only inferred, each guessed person once, as read today", () => {
  const refOf = (r: string) => (r === "person:sam" ? "person:inf_sam" : r);
  const peopleWith = (corrections: Parameters<typeof guessTestOf>[0] = []) => ({
    isGuess: (r: string) => guessTestOf(corrections)(refOf(r)),
    refOf,
  });
  const people = peopleWith();
  const o = (over = {}) => ({
    about: undefined,
    subjects: ["person:zoe"],
    ...over,
  });
  expect(guessedOf(o(), people)).toEqual([]);
  expect(guessedOf(o({ about: "person:inf_kit" }), people)).toEqual([
    "person:inf_kit",
  ]);
  // A ref that folds into an inferred person rests on that guess, once.
  expect(
    guessedOf(o({ about: "person:sam", subjects: ["person:inf_sam"] }), people)
  ).toEqual(["person:inf_sam"]);
  // His word that it is them ends the doubt; a refusal of one handle does not.
  const said = peopleWith([
    {
      at: "2026-10-01T10:00:00.000Z",
      kind: "not-this-person",
      nameOrHandle: "Kit",
      person: "person:inf_kit",
      schemaVersion: 1,
    },
  ]);
  expect(guessedOf(o({ about: "person:inf_kit" }), said)).toEqual([
    "person:inf_kit",
  ]);
  const confirmed = peopleWith([
    {
      at: "2026-10-01T10:00:00.000Z",
      kind: "this-is",
      nameOrHandle: "Kit",
      person: "person:inf_kit",
      schemaVersion: 1,
    },
  ]);
  expect(guessedOf(o({ about: "person:inf_kit" }), confirmed)).toEqual([]);
});

test("an episode is said as its title, time (a same-day end as a time only), place and the people it was with", () => {
  const m = {
    end: `${YEAR}-09-07 22:30`,
    people: [
      { ref: "person:zoe", role: "with" },
      { ref: "unknown:Bob", role: "with" },
      { ref: "person:dad", role: "told" },
    ],
    place: "Chez Paul",
    start: `${YEAR}-09-07 20:00`,
    title: "Dinner",
  } as Episode;
  const names = new Map([["person:zoe", "Zoé"]]);
  const name = (ref: string) => names.get(ref) ?? ref.split(":")[1] ?? ref;
  expect(episodeText(m, name)).toBe(
    "Dinner, 7 Sep 20:00–22:30, at Chez Paul; with Zoé, Bob; told dad."
  );
  expect(
    episodeText(
      {
        ...m,
        end: `${YEAR}-09-08`,
        people: [],
        place: null,
      },
      name
    )
  ).toBe("Dinner, 7 Sep 20:00–8 Sep.");
});

test("an episode is rated with the one person with a page it was with, as who.ts says today; else under events", () => {
  const m = (people: [string, string][]) =>
    ({
      people: people.map(([ref, role]) => ({ ref, role })),
    }) as Episode;
  const paged = new Set(["person:zoe", "person:dad"]);
  const refOf = (r: string) => (r === "unknown:Zoé" ? "person:zoe" : r);
  expect(
    episodeGroup(
      m([
        ["unknown:Zoé", "with"],
        ["person:dad", "told"],
      ]),
      paged,
      refOf
    )
  ).toBe("person:zoe");
  expect(
    episodeGroup(
      m([
        ["person:zoe", "with"],
        ["person:dad", "with"],
      ]),
      paged,
      refOf
    )
  ).toBe("episodes");
  expect(episodeGroup(m([["person:bob", "with"]]), paged, refOf)).toBe(
    "episodes"
  );
});
