import { expect, test } from "bun:test";
import type { Episode } from "../records/episode";
import {
  doubtful,
  doubtsOf,
  episodeGroup,
  episodeText,
  type MemoryLine,
} from "./doubts";

const claim = (ref: string, over: Partial<MemoryLine> = {}): MemoryLine => ({
  date: "2026-10-01",
  doubts: ["guessed-person"],
  group: "area:shop",
  importance: 3,
  kind: "fact",
  ref,
  source: "whatsapp",
  text: ref,
  units: ["unit_000000000000"],
  ...over,
});
/** This year: dates in it are said without the year. */
const YEAR = new Date().getFullYear();

test("a fact is doubtful when who it's about is only inferred; low confidence only counts beside it", () => {
  const refOf = (r: string) => (r === "person:sam" ? "person:inf_sam" : r);
  const o = (over = {}) => ({
    about: undefined,
    confidence: 0.9,
    entities: ["person:zoe"],
    unit: "unit_a",
    ...over,
  });
  expect(doubtsOf(o(), refOf)).toEqual([]);
  expect(doubtsOf(o({ confidence: 0.2 }), refOf)).toEqual([]);
  expect(doubtsOf(o({ about: "person:inf_kit" }), refOf)).toEqual([
    "guessed-person",
  ]);
  // An inferred person he since named is not a guess; one a ref folds into still is.
  expect(doubtsOf(o({ entities: ["person:sam"] }), refOf)).toEqual([
    "guessed-person",
  ]);
  expect(
    doubtsOf(o({ about: "person:inf_kit", confidence: 0.2 }), refOf)
  ).toEqual(["guessed-person", "low-confidence"]);
});

test("the fact checks he sees first: the most important, then the most doubtful, then the newest; never a sure, minor, stated or homeless claim", () => {
  const claims = [
    claim("obs_minor", { importance: 1 }),
    claim("obs_sure", { doubts: [] }),
    claim("obs_stated"),
    claim("obs_homeless", { group: null }),
    claim("obs_two", { importance: 2 }),
    claim("obs_old", { date: "2026-09-01" }),
    claim("obs_new"),
    claim("obs_both", {
      date: "2026-08-01",
      doubts: ["guessed-person", "low-confidence"],
    }),
  ];
  expect(
    doubtful(claims, new Set(["obs_stated"]), 10).map((c) => c.ref)
  ).toEqual(["obs_both", "obs_new", "obs_old", "obs_two"]);
  expect(doubtful(claims, new Set(), 2)).toHaveLength(2);
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
