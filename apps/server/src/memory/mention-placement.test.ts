import { expect, test } from "bun:test";
import { Person } from "../records/truth";
import { peopleNamedBy, placementOf, saidOf } from "./mention-placement";
import { OWNER } from "./read-truth";
import { tiesNow } from "./ties";
import { foldsOf } from "./who";

const person = (id: string, name: string, relation: string, aliases = []) =>
  Person.parse({ aliases, id, name, relation });
const people = [
  person("hugo-blanc", "Hugo Blanc", "friend", ["Hugo"] as never),
  person("lea-morel", "Léa Morel", "sister", ["Léa"] as never),
  person("anne-morel", "Anne Morel", "mother"),
  person("paul-roche", "Paul Roche", "colleague", ["Paul"] as never),
];
const directory = { ...foldsOf(people, [], [], []), truth: { people } };
const ties = tiesNow(directory);
const HUGO = "person:hugo-blanc";
const LEA = "person:lea-morel";
const ANNE = "person:anne-morel";
const PAUL = "person:paul-roche";
const said = (line: string, by = OWNER) => ({ by, line });
const place = (
  who: string,
  line: string,
  over: {
    by?: string;
    namedOn?: { by: string; line: string };
    ref?: string;
  } = {}
) => placementOf({ by: OWNER, line, who, ...over }, directory, ties);
const earlier = (line: string, by = OWNER) => ({ namedOn: said(line, by) });

test("code's own reading is the floor: a name or his relation word stays placed whatever the read picked, `unknown` included", () => {
  expect(place("Hugo", "Hugo is late", { ref: "unknown" })).toEqual({
    proof: "name",
    ref: HUGO,
  });
  expect(place("Hugo", "Hugo is late", { ref: LEA })?.ref).toBe(HUGO);
  expect(place("ma mère", "ma mère est là", { ref: "unknown" })).toEqual({
    proof: "relation_word",
    ref: ANNE,
  });
  expect(place("ma mère", "ma mère est là", { ref: PAUL })?.ref).toBe(ANNE);
  // A read that picks no one is placed by code alone, as before.
  expect(place("Hugo", "Hugo is late")?.ref).toBe(HUGO);
});

test("a pronoun's pick stands only with an earlier line that names the same person: by name, by his relation word", () => {
  const she = "elle abuse";
  expect(
    place("elle", she, { ref: LEA, ...earlier("Léa a encore annulé") })
  ).toEqual({ proof: "earlier_naming", ref: LEA });
  expect(
    place("elle", she, { ref: ANNE, ...earlier("ma mère est là") })
  ).toEqual({ proof: "earlier_naming", ref: ANNE });
  // He, in English; the pick is read as today's person (`canon`).
  expect(
    place("him", "tell him", { ref: HUGO, ...earlier("Hugo called") })?.ref
  ).toBe(HUGO);
  // No pick, `unknown`, an invented ref, no earlier line: no one.
  expect(place("elle", she, earlier("Léa a annulé"))).toBeNull();
  expect(place("elle", she, { ref: "unknown", ...earlier("Léa") })).toBeNull();
  expect(
    place("elle", she, { ref: "person:ghost", ...earlier("Léa") })
  ).toBeNull();
  expect(place("elle", she, { ref: LEA })).toBeNull();
  // The earlier line names someone else.
  expect(
    place("elle", she, { ref: LEA, ...earlier("Hugo a annulé") })
  ).toBeNull();
  // "la mère de Paul" is no one's "ma mère": Paul is named, his mother is not.
  expect(
    place("elle", she, { ref: ANNE, ...earlier("la mère de Paul est là") })
  ).toBeNull();
  expect(
    place("elle", she, { ref: PAUL, ...earlier("la mère de Paul est là") })?.ref
  ).toBe(PAUL);
  // A friend's "ma mère" is their own mother, not his.
  expect(
    place("elle", she, {
      ref: ANNE,
      ...earlier("ma mère est là", "Hugo Blanc"),
    })
  ).toBeNull();
  // The words must be on the line.
  expect(
    place("elle", "il abuse", { ref: LEA, ...earlier("Léa a annulé") })
  ).toBeNull();
});

test("the earlier-naming proof is for a closed list of pronouns: an unknown name or a relation word of several candidates never passes", () => {
  const pick = { ref: HUGO, ...earlier("Hugo called") };
  expect(place("Karim", "Karim a dit", pick)).toBeNull();
  expect(place("ce mec", "ce mec a dit", pick)).toBeNull();
  expect(place("mon frère", "mon frère a dit", pick)).toBeNull();
  expect(place("mon ami", "mon ami a dit", pick)).toBeNull();
});

test("a line names the people its names, handles and his own relation words say, and no one by a part of a name", () => {
  const named = (line: string, by = OWNER) =>
    [...peopleNamedBy(said(line, by), directory, ties)].sort();
  expect(named("Hugo et Léa")).toEqual([HUGO, LEA]);
  expect(named("ma mère")).toEqual([ANNE]);
  expect(named("ma mère", "Hugo Blanc")).toEqual([]);
  expect(named("la mère de Paul")).toEqual([PAUL]);
  expect(saidOf({ fromMe: true, sender: "me", text: "x" } as never)).toEqual({
    by: OWNER,
    line: "x",
  });
});
