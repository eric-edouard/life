import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeJson } from "../core/files";
import { Correction } from "../records/observation";
import { TieId } from "../records/tie";
import { Person } from "../records/truth";
import { MENTIONS, mentionsPath, TIES } from "./memory-files";
import type { Mention } from "./mentions";
import { OWNER } from "./read-truth";
import { said } from "./record-fixtures";
import { readTies, tieLinesOf, tiesNow, writeTies } from "./ties";
import { foldsOf, placementOf } from "./who";

const person = (id: string, name: string, relation?: string) =>
  Person.parse({ aliases: [], id, name, relation });
const directory = (people: Person[], corrections: Correction[] = []) => ({
  ...foldsOf(people, [], corrections, []),
  corrections,
  truth: { people },
});
const mention = (
  who: string,
  quote: string,
  by = "+1",
  at = "2026-10-02T12:00:00.000Z"
): Mention => ({ at, by, line: quote, quote, unit: "unit_000000000001", who });
const keep = (m: Mention) =>
  writeJson(mentionsPath("2026-10"), {
    built: "2026-10-09T00:00:00.000Z",
    days: { "2026-10-02": [m] },
  });
const lea = person("lea", "Lea");
const hugo = person("hugo", "Hugo", "father");
const friend = person("fred", "Fred");

test("a relation's words beside a name that resolves write a tie, as written; a name only on the other side, a possessive and the speaker's own name do not", () => {
  const people = directory([lea, hugo, friend]);
  const [tie] = tieLinesOf(
    [mention("my partner", "my partner Lea is ill")],
    people
  );
  expect(tie).toMatchObject({
    by: "+1",
    of: "Lea",
    quote: "my partner Lea is ill",
    said: "my partner Lea is ill",
    words: "my partner",
  });
  expect(TieId.safeParse(tie?.id).success).toBe(true);
  const lines = (...m: Mention[]) => tieLinesOf(m, people);
  expect(lines(mention("my friend", "Lea, my friend, came"))[0]?.of).toBe(
    "Lea"
  );
  expect(lines(mention("my friend", "my friend and Lea came"))).toEqual([]);
  expect(lines(mention("Lea's sister", "Lea's sister came"))).toEqual([]);
  expect(lines(mention("my friend", "my friend Zed came"))).toEqual([]);
  // A name is no tie, and no one is their own friend.
  expect(lines(mention("Lea", "my partner Lea is ill"))).toEqual([]);
  const same = directory([lea], []);
  expect(
    tieLinesOf([mention("my partner", "my partner Lea", "Lea")], same)
  ).toEqual([]);
});

test("a friend's 'my partner Lea' writes a tie; his later 'my partner' lands on Lea; not-this-tie removes it and the next night does not write it again", () => {
  const people = directory([lea, hugo, friend]);
  try {
    keep(mention("my partner", "my partner Lea is ill", "+1"));
    expect(writeTies(people)).toEqual({ failed: 0, ties: 1 });
    // Once only, a second night writes nothing.
    expect(writeTies(people)).toEqual({ failed: 0, ties: 0 });
    const stored = readTies();
    expect(stored).toHaveLength(1);
    expect(readFileSync(TIES, "utf8")).not.toContain("person:");
    // "+1" is the friend's handle: until it resolves to someone, nothing says who "my partner" is of.
    const handle = {
      ...foldsOf(
        [lea, hugo, friend],
        [],
        [said({ kind: "this-is", nameOrHandle: "+1", person: "person:fred" })],
        []
      ),
      truth: { people: [lea, hugo, friend] },
    };
    expect(tiesNow(people, stored).map((t) => t.by)).toEqual([OWNER]);
    const ties = tiesNow(handle, stored);
    expect(ties).toEqual([
      expect.objectContaining({
        by: "person:fred",
        of: "person:lea",
        word: "partner",
      }),
      { by: OWNER, of: "person:hugo", word: "father" },
    ]);
    const later = mention("my partner", "my partner left", "+1");
    expect(placementOf(later, handle, ties)).toEqual({
      proof: "tie",
      ref: "person:lea",
    });
    // Another speaker's "my partner" is not Lea; his directory's father stays a relation word.
    expect(placementOf({ ...later, by: "+9" }, handle, ties)).toBeNull();
    expect(
      placementOf(mention("my father", "my father", OWNER), handle, ties)?.proof
    ).toBe("relation_word");
    // He says it is not this tie: it is gone when read, and never written again.
    const removed = Correction.parse({
      at: "2026-10-03T00:00:00.000Z",
      kind: "not-this-tie",
      schemaVersion: 1,
      ties: [stored[0]?.id],
    });
    const after = { ...handle, corrections: [removed] };
    expect(tiesNow(after, stored).map((t) => t.by)).toEqual([OWNER]);
    expect(placementOf(later, after, tiesNow(after, stored))).toBeNull();
    rmSync(TIES);
    expect(writeTies(after)).toEqual({ failed: 0, ties: 0 });
    expect(existsSync(TIES)).toBe(false);
  } finally {
    rmSync(TIES, { force: true });
    rmSync(MENTIONS, { force: true, recursive: true });
  }
});

test("a word that names no one by its nature is placed by a tie said in words, only when it is the speaker's one; the newest line of a pair is the present one", () => {
  const people = directory([lea, friend]);
  const said1 = tieLinesOf(
    [mention("my friend", "my friend Fred came", OWNER)],
    people
  );
  const now = tiesNow(people, said1);
  expect(
    placementOf(mention("my friend", "my friend", OWNER), people, now)
  ).toEqual({
    proof: "tie",
    ref: "person:fred",
  });
  // Two friends said: no one.
  const two = [
    ...said1,
    ...tieLinesOf([mention("my friend", "my friend Lea came", OWNER)], people),
  ];
  expect(
    placementOf(
      mention("my friend", "my friend", OWNER),
      people,
      tiesNow(people, two)
    )
  ).toBeNull();
  // The same pair said later as another word: only the newest counts.
  const later = tieLinesOf(
    [
      mention(
        "my boss",
        "my boss Fred came",
        OWNER,
        "2026-10-09T12:00:00.000Z"
      ),
    ],
    people
  );
  expect(tiesNow(people, [...later, ...said1]).map((t) => t.word)).toEqual([
    "boss",
  ]);
  // His directory's word beats a stored one for the pair, and keeps the quote.
  const listed = directory([person("fred", "Fred", "friend"), lea]);
  expect(tiesNow(listed, said1)).toEqual([
    expect.objectContaining({ quote: "my friend Fred came", word: "friend" }),
  ]);
});
