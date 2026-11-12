import { expect, test } from "bun:test";
import { PersonRef } from "../records/fields";
import {
  ContactPerson,
  contactIdOf,
  type InferredPerson,
} from "../records/observation";
import { Person } from "../records/truth";
import type { Contact } from "../sources/contacts";
import {
  type ContactNow,
  contactPeopleOf,
  contactsNow,
} from "./contact-people";
import { answeredBy } from "./people";
import { foldsOf, meant } from "./who";

const AT = "2026-11-12T03:00:00.000Z";
const card = (id: string, name: string | null, handles: string[]): Contact => ({
  addresses: [],
  birthday: null,
  handles,
  id,
  name,
  profiles: [],
  related: [],
  work: null,
});
const seenOf = (...keys: string[]) => new Set(keys);
/** The people a run of the night leaves, from the cards and what was stored. */
const after = (
  cards: Contact[],
  stored: ContactPerson[],
  seen: Set<string>
) => {
  const lines = contactPeopleOf(cards, stored, seen, AT);
  return {
    lines,
    now: contactsNow([...stored, ...lines]),
    stored: [...stored, ...lines],
  };
};
const ANA = card("card-ana", "Ana Lopez", [
  "+33 6 11 11 11 11",
  "ana@example.com",
]);
const ANA_KEY = "611111111";

test("a card whose handle his messages hold becomes a person, under an id from the card, once", () => {
  const first = after(
    [ANA, card("card-ben", "Ben Ito", ["+33622222222"])],
    [],
    seenOf(ANA_KEY)
  );
  // Ben wrote nothing Life holds: his card is not copied.
  expect(first.now).toEqual([
    {
      card: "card-ana",
      id: contactIdOf("card-ana"),
      name: "Ana Lopez",
      surfaces: ["+33 6 11 11 11 11", "ana@example.com"],
    },
  ]);
  expect(PersonRef.safeParse(`person:${first.now[0]?.id}`).success).toBe(true);
  expect(ContactPerson.safeParse({ ...first.lines[0], id: "x" }).success).toBe(
    false
  );
  // The same cards again: nothing to append.
  expect(after([ANA], first.stored, seenOf(ANA_KEY)).lines).toEqual([]);
});

test("a card renamed, given a number or deleted keeps its person", () => {
  const first = after([ANA], [], seenOf(ANA_KEY));
  const renamed = after(
    [{ ...ANA, handles: [...ANA.handles, "+33644444444"], name: "Ana L." }],
    first.stored,
    seenOf()
  );
  expect(renamed.now).toEqual([
    {
      card: "card-ana",
      id: contactIdOf("card-ana"),
      name: "Ana L.",
      surfaces: ["+33 6 11 11 11 11", "ana@example.com", "+33644444444"],
    },
  ]);
  // The card is gone from Contacts: nothing is appended, the person stays.
  const deleted = after([], renamed.stored, seenOf());
  expect(deleted.lines).toEqual([]);
  expect(deleted.now).toEqual(renamed.now);
});

test("two cards sharing a handle are one person under one name, never under two", () => {
  // The same person in two accounts: one person, the second card's other handle with it.
  const twice = after(
    [
      ANA,
      card("card-ana-icloud", "ana lopez", [
        "+33611111111",
        "ana@work.example",
      ]),
    ],
    [],
    seenOf(ANA_KEY)
  );
  expect(twice.now.map((p) => [p.card, p.surfaces])).toEqual([
    [
      "card-ana",
      [
        "+33 6 11 11 11 11",
        "ana@example.com",
        "+33611111111",
        "ana@work.example",
      ],
    ],
  ]);
  // Another name on the same number: the first card (by its id) keeps the number, the other is not that person.
  const other = after(
    [ANA, card("card-zed", "Zed Other", ["+33611111111", "+33655555555"])],
    [],
    seenOf(ANA_KEY, "655555555")
  );
  expect(other.now.map((p) => [p.card, p.surfaces])).toEqual([
    ["card-ana", ["+33 6 11 11 11 11", "ana@example.com"]],
    ["card-zed", ["+33655555555"]],
  ]);
});

const truth = [
  Person.parse({
    aliases: ["Bea"],
    handles: { email: [], phone: ["+33677777777"], whatsapp: [] },
    id: "bea",
    name: "Beatrice Roy",
  }),
];
const now = (id: string, name: string, surfaces: string[]): ContactNow => ({
  card: id,
  id: contactIdOf(id),
  name,
  surfaces,
});
const guess = (id: string, surfaces: string[]): InferredPerson => ({
  area: null,
  at: AT,
  confidence: 0.9,
  evidence: [{ quote: "hello there", unit: "unit_1" }],
  id,
  madeBy: { engine: "codex", model: "m", prompt: "p", run: "r" },
  name: "the neighbour",
  person: null,
  project: null,
  relation: "a neighbour",
  schemaVersion: 1,
  surfaces,
});

test("a contact person is read by a handle of its card, however written, and by its name; his word and truth/ come first", () => {
  const ana = now("card-ana", "Ana Lopez", [
    "+33 6 11 11 11 11",
    "ana@example.com",
  ]);
  const self = `person:${ana.id}`;
  const { resolve } = foldsOf(truth, [], [], [ana]);
  expect(resolve("0611111111")).toBe(self);
  expect(resolve("+33611111111")).toBe(self);
  expect(resolve("ANA@example.com")).toBe(self);
  // The name another source gives (a face he named in Photos, an export's display name).
  expect(resolve("Ana Lopez")).toBe(self);
  expect(resolve("Ana")).toBeNull();
  // A name two contact people share is nobody.
  const twin = now("card-ana-2", "Ana Lopez", ["+33688888888"]);
  expect(foldsOf(truth, [], [], [ana, twin]).resolve("Ana Lopez")).toBeNull();
  const said = (c: object) => ({ at: AT, schemaVersion: 1 as const, ...c });
  expect(
    foldsOf(
      truth,
      [],
      [
        said({
          kind: "this-is",
          person: "person:bea",
          surface: "+33611111111",
        }),
      ] as never,
      [ana]
    ).resolve("+33611111111")
  ).toBe("person:bea");
  expect(
    foldsOf(
      truth,
      [],
      [
        said({
          kind: "not-this-person",
          person: self,
          surface: "+33611111111",
        }),
      ] as never,
      [ana]
    ).resolve("+33611111111")
  ).toBeNull();
});

test("one person across every channel: a card of someone in truth/ is that person and brings its other handles; a guess for its number is the contact person", () => {
  // Bea is in truth/ under one number; her card holds a second number and an email, and goes by her alias.
  const bea = now("card-bea", "Bea", [
    "+33677777777",
    "+33699999999",
    "bea@example.com",
  ]);
  const byName = now("card-bea-old", "Beatrice Roy", ["+33600000009"]);
  const ana = now("card-ana", "Ana Lopez", ["+33611111111"]);
  const inferred = [guess("inf_the-neighbour", ["+33611111111"])];
  const { canon, resolve } = foldsOf(truth, inferred, [], [bea, byName, ana]);
  // Every channel reads as Bea: her number in truth/, her card's second number and email, the name a photo carries.
  for (const surface of [
    "+33677777777",
    "+33699999999",
    "bea@example.com",
    "Beatrice Roy",
    "bea",
    "+33600000009",
  ]) {
    expect(resolve(surface)).toBe("person:bea");
  }
  expect(canon(`person:${bea.id}`)).toBe("person:bea");
  expect(canon(`person:${byName.id}`)).toBe("person:bea");
  // The guess Life made for Ana's number is Ana: refs stored under the guess keep working.
  expect(canon("person:inf_the-neighbour")).toBe(`person:${ana.id}`);
  expect(resolve("+33611111111")).toBe(`person:${ana.id}`);
  // No question is spent on her number, and by name she is found.
  expect(answeredBy(resolve, inferred)("+33611111111")).toBe(true);
  const found = meant("Ana Lopez", {
    canon,
    contacts: [bea, byName, ana],
    inferred,
    resolve,
    truth: { people: truth } as never,
  });
  expect(found.known).toBe(ana.id);
  // Folded people are not listed twice.
  expect(found.all.map((p) => p.id)).toEqual(["bea", ana.id]);
});
