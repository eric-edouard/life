import { expect, test } from "bun:test";
import { Correction } from "../records/observation";
import {
  blankCuts,
  cutOf,
  type DeletionLayers,
  type Deletions,
  deletedWordsOf,
  deletionsOf,
  dependentsOf,
  isDeleted,
  isHiddenUntilRedone,
  NO_DELETIONS,
  shownKeyOf,
} from "./deletions";

// A deletion: its record, and the one rule every read applies to the words it removed. Made-up refs throughout.

const deleted = (over: Partial<Correction> = {}) =>
  ({
    at: "2026-11-24T09:00:00.000Z",
    cuts: [],
    kind: "deleted",
    oldHashes: [],
    refs: [],
    said: "that goes",
    schemaVersion: 1,
    shown: [],
    withSources: false,
    ...over,
  }) as Correction;

test("every deletion reads as one: the refs gone whole, the cuts of each ref, the old hashes and what was shown them", () => {
  const d = deletionsOf([
    {
      at: "2026-11-01T00:00:00.000Z",
      kind: "wrong",
      observations: ["obs_1"],
    } as Correction,
    deleted({ refs: ["unit_0123456789ab"] }),
    deleted({
      at: "2026-11-20T00:00:00.000Z",
      cuts: [{ digest: "0".repeat(16), from: 2, ref: "m1", to: 5 }],
      oldHashes: ["h1"],
      shown: [shownKeyOf.persona("person:kit")],
    }),
  ]);
  expect([...d.refs]).toEqual(["unit_0123456789ab"]);
  expect([...(d.cuts.get("m1") ?? [])].map((c) => [c.from, c.to])).toEqual([
    [2, 5],
  ]);
  expect([...d.oldHashes]).toEqual(["h1"]);
  expect(d.hidden.get("persona:person:kit")).toBe("2026-11-20T00:00:00.000Z");
});

test("a cut blanks its own words and no others, keeping every place after it", () => {
  const text = "Meet me at the pier, room 4B.";
  const cut = cutOf("m1", text, 11, 14);
  expect(text.slice(cut.from, cut.to)).toBe("the");
  expect(blankCuts(text, [cut])).toBe("Meet me at     pier, room 4B.");
  // Places hold: the rest of the line sits where it did.
  expect(blankCuts(text, [cut]).length).toBe(text.length);
  expect(blankCuts(text, [cut]).slice(cut.to)).toBe(text.slice(cut.to));
  // A digest that is not the words at those places (the text changed since) blanks nothing.
  expect(
    blankCuts(text, [{ ...cut, digest: cutOf("m1", "x", 0, 1).digest }])
  ).toBe(text);
  // Newlines hold: only words are blanked, so every line keeps its places.
  const lines = "a\nb c";
  expect(blankCuts(lines, [cutOf("m", lines, 2, 4)])).toBe("a\n  c");
});

test("a deleted line has no words at all; a cut line keeps everything else; nothing deleted leaves the words as they are", () => {
  const text = "the pier at noon";
  const d: Deletions = {
    ...NO_DELETIONS,
    cuts: new Map([["m1", [cutOf("m1", text, 0, 3)]]]),
    refs: new Set(["m2"]),
  };
  expect(deletedWordsOf("m1", text, d)).toBe("    pier at noon");
  expect(deletedWordsOf("m2", text, d)).toBe("");
  expect(deletedWordsOf("m3", text, d)).toBe(text);
});

test("a record read from deleted words is gone: by its id, the line it cites, its unit or the hash it was read under", () => {
  const d: Deletions = {
    ...NO_DELETIONS,
    oldHashes: new Set(["old"]),
    refs: new Set(["obs_1", "m2", "unit_1"]),
  };
  const read = (over = {}) => ({ id: "obs_9", ref: "m9", ...over });
  expect(isDeleted(read({ id: "obs_1" }), d)).toBe(true);
  expect(isDeleted(read({ ref: "m2" }), d)).toBe(true);
  expect(isDeleted(read({ unit: "unit_1" }), d)).toBe(true);
  expect(isDeleted(read({ unitHash: "old" }), d)).toBe(true);
  expect(isDeleted(read({ unit: "unit_2", unitHash: "new" }), d)).toBe(false);
});

test("a derived read shown deleted words shows again only once it is redone after that deletion", () => {
  const d: Deletions = {
    ...NO_DELETIONS,
    hidden: new Map([
      [shownKeyOf.persona("person:kit"), "2026-11-20T00:00:00.000Z"],
    ]),
  };
  expect(
    isHiddenUntilRedone("persona:person:kit", "2026-11-01T00:00:00.000Z", d)
  ).toBe(true);
  expect(
    isHiddenUntilRedone("persona:person:kit", "2026-11-21T00:00:00.000Z", d)
  ).toBe(false);
  expect(
    isHiddenUntilRedone("persona:person:mai", "2026-11-01T00:00:00.000Z", d)
  ).toBe(false);
});

const layers = (over: Partial<DeletionLayers> = {}): DeletionLayers => ({
  cards: [],
  links: [],
  matters: [],
  observations: [],
  replies: [],
  shown: [],
  todoItems: ["entry_0123456789ab"],
  units: [],
  ...over,
});

test("what a deletion reaches: a message its unit, the unit its facts, the facts their matter, cards, links and reads", () => {
  const dependents = dependentsOf(["m1"], {
    cards: [
      { id: "dec_aaaaaaaaaaaa", subject: "obs_1" },
      { id: "dec_bbbbbbbbbbbb" },
    ],
    links: [
      { earlier: "obs_1", later: "ep_1" },
      { earlier: "obs_9", later: "ep_9" },
    ],
    matters: [
      { id: "matter_1", steps: ["obs_1", "unit_1"] },
      { id: "matter_2", steps: ["obs_9"] },
    ],
    observations: [
      { id: "obs_1", source: "m1", unit: "unit_1" },
      { id: "obs_2", source: "m2", unit: "unit_2" },
    ],
    replies: [
      { id: "reply:aa", refs: ["m1"] },
      { id: "reply:bb", refs: ["m2"] },
    ],
    shown: [
      { id: shownKeyOf.persona("person:kit"), units: ["unit_1"] },
      { id: shownKeyOf.persona("person:mai"), units: ["unit_2"] },
    ],
    todoItems: ["entry_0123456789ab"],
    units: [
      { id: "unit_1", refs: ["m1"] },
      { id: "unit_2", refs: ["m2"] },
    ],
  });
  expect(dependents).toEqual({
    // A card on nothing it names goes too: it may show the words (`subject` absent).
    cards: ["dec_aaaaaaaaaaaa", "dec_bbbbbbbbbbbb"],
    facts: ["obs_1"],
    links: ["obs_1"],
    matters: ["matter_1"],
    replies: ["reply:aa"],
    shown: ["persona:person:kit"],
    todoItems: [],
    units: ["unit_1"],
  });
});

test("a to-do item's key among the refs is his list's to remove", () => {
  expect(dependentsOf(["entry_0123456789ab"], layers()).todoItems).toEqual([
    "entry_0123456789ab",
  ]);
});

test("a matter deleted takes its own to-do items with it, never another matter's", () => {
  const withMatters = layers({
    matters: [
      { id: "matter_1", steps: ["entry_0123456789ab", "obs_1"] },
      { id: "matter_2", steps: ["entry_0123456789ac"] },
    ],
    todoItems: ["entry_0123456789ab", "entry_0123456789ac"],
  });
  expect(dependentsOf(["matter_1"], withMatters).todoItems).toEqual([
    "entry_0123456789ab",
  ]);
  // A step he names closes its matter, but the matter itself stays: its to-do items stay in his list too.
  expect(dependentsOf(["obs_1"], withMatters).todoItems).toEqual([]);
});

test("a deletion names refs, cuts or both: one that names neither is refused when it is recorded", () => {
  expect(Correction.safeParse(deleted()).success).toBe(false);
  expect(
    Correction.safeParse(deleted({ refs: ["unit_0123456789ab"] })).success
  ).toBe(true);
  expect(
    Correction.safeParse(
      deleted({
        cuts: [{ digest: "0".repeat(16), from: 0, ref: "m1", to: 3 }],
      })
    ).success
  ).toBe(true);
  // A cut removes at least one character.
  expect(
    Correction.safeParse(
      deleted({
        cuts: [{ digest: "0".repeat(16), from: 3, ref: "m1", to: 3 }],
      })
    ).success
  ).toBe(false);
});
