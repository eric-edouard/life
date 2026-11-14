import { expect, test } from "bun:test";
import { PersonRef } from "../records/fields";
import {
  ContactPerson,
  contactIdOf,
  type InferredPerson,
  peopleOutsideDirectoryOf,
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
      handles: ["+33 6 11 11 11 11", "ana@example.com"],
      id: contactIdOf("card-ana"),
      name: "Ana Lopez",
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
      handles: ["+33 6 11 11 11 11", "ana@example.com", "+33644444444"],
      id: contactIdOf("card-ana"),
      name: "Ana L.",
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
  expect(twice.now.map((p) => [p.card, p.handles])).toEqual([
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
  expect(other.now.map((p) => [p.card, p.handles])).toEqual([
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
const now = (id: string, name: string, handles: string[]): ContactNow => ({
  card: id,
  handles,
  id: contactIdOf(id),
  name,
});
const guess = (id: string, handles: string[]): InferredPerson => ({
  area: null,
  at: AT,
  confidence: 0.9,
  evidence: [{ quote: "hello there", unit: "unit_1" }],
  id,
  madeBy: { engine: "codex", model: "m", prompt: "p", run: "r" },
  name: "the neighbour",
  namesAndHandles: handles,
  person: null,
  project: null,
  relation: "a neighbour",
  schemaVersion: 1,
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
          nameOrHandle: "+33611111111",
          person: "person:bea",
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
          nameOrHandle: "+33611111111",
          person: self,
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
  for (const nameOrHandle of [
    "+33677777777",
    "+33699999999",
    "bea@example.com",
    "Beatrice Roy",
    "bea",
    "+33600000009",
  ]) {
    expect(resolve(nameOrHandle)).toBe("person:bea");
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
    outsideDirectory: peopleOutsideDirectoryOf([bea, byName, ana], inferred),
    resolve,
    truth: { people: truth } as never,
  });
  expect(found.known).toBe(ana.id);
  // Folded people are not listed twice.
  expect(found.all.map((p) => p.id)).toEqual(["bea", ana.id]);
});

test("a card renamed and nothing else is the same person under its new name", () => {
  const first = after([ANA], [], seenOf(ANA_KEY));
  const renamed = after(
    [{ ...ANA, name: "Ana Maria" }],
    first.stored,
    seenOf()
  );
  expect(renamed.lines).toHaveLength(1);
  expect(renamed.now.map((p) => [p.id, p.name])).toEqual([
    [contactIdOf("card-ana"), "Ana Maria"],
  ]);
});

test("his Contacts outrank a guess: a model's link of one number to someone in truth/ does not move the card", () => {
  const ana = now("card-ana", "Ana Lopez", ["+33611111111", "+33612121212"]);
  const linked = {
    ...guess("inf_the-neighbour", ["+33611111111"]),
    person: "person:bea",
  };
  const { canon, resolve } = foldsOf(truth, [linked], [], [ana]);
  expect(resolve("+33611111111")).toBe(`person:${ana.id}`);
  expect(resolve("+33612121212")).toBe(`person:${ana.id}`);
  expect(canon("person:inf_the-neighbour")).toBe(`person:${ana.id}`);
});

test("a card that shares only a short name with someone whose numbers are known is someone else", () => {
  // Bea's numbers are in truth/: a card "Bea" under another number is not her; a card under her whole name is.
  const other = now("card-other-bea", "Bea", ["+33600000042"]);
  const { canon, resolve } = foldsOf(truth, [], [], [other]);
  expect(canon(`person:${other.id}`)).toBe(`person:${other.id}`);
  expect(resolve("+33600000042")).toBe(`person:${other.id}`);
  // Her whole name on another number is her second number, unless he said that number is not her.
  const second = now("card-bea-2", "Beatrice Roy", ["+33 6 00 00 00 44"]);
  expect(foldsOf(truth, [], [], [second]).resolve("0600000044")).toBe(
    "person:bea"
  );
  const notHer = {
    at: AT,
    kind: "not-this-person",
    nameOrHandle: "+33600000044",
    person: "person:bea",
    schemaVersion: 1,
  };
  expect(
    foldsOf(truth, [], [notHer] as never, [second]).resolve("0600000044")
  ).toBe(`person:${second.id}`);
  // Someone truth/ gives no number: nothing says otherwise, so a card under one of their names is them.
  const cy = Person.parse({
    aliases: ["Cy"],
    id: "cyril",
    name: "Cyril Blanc",
  });
  const cyCard = now("card-cy", "Cy", ["+33600000043"]);
  expect(foldsOf([cy], [], [], [cyCard]).resolve("+33600000043")).toBe(
    "person:cyril"
  );
});

test("a card whose whole name says one person and whose number says another is no one's: Life does not guess", () => {
  // A card under Cyril's whole name holds Bea's number and an address (a card he renamed, or two people in one card).
  const cyril = Person.parse({
    handles: { email: [], phone: ["+33600000050"], whatsapp: [] },
    id: "cyril",
    name: "Cyril Blanc",
  });
  const mixed = now("card-mixed", "Cyril Blanc", [
    "+33677777777",
    "cy@example.com",
  ]);
  const self = `person:${mixed.id}`;
  const { ambiguousCards, canon, resolve } = foldsOf(
    [...truth, cyril],
    [],
    [],
    [mixed]
  );
  expect(ambiguousCards).toEqual([
    { card: self, people: ["person:cyril", "person:bea"] },
  ]);
  // Whatever the order of its handles, and with Cyril's own number on it too.
  const reordered = now("card-mixed", "Cyril Blanc", [
    "+33600000050",
    "cy@example.com",
    "+33677777777",
  ]);
  expect(
    foldsOf([...truth, cyril], [], [], [reordered]).ambiguousCards
  ).toEqual([{ card: self, people: ["person:cyril", "person:bea"] }]);
  // Once he says whose the card is, it is placed and no longer listed.
  const settled = foldsOf(
    [...truth, cyril],
    [],
    [
      {
        at: AT,
        from: self,
        kind: "same-person",
        schemaVersion: 1,
        to: "person:bea",
      },
    ] as never,
    [mixed]
  );
  expect(settled.ambiguousCards).toEqual([]);
  expect(settled.resolve("cy@example.com")).toBe("person:bea");
  expect(canon(self)).toBe(self);
  // The number truth/ knows is still Bea's; the address is the card's own, neither Bea's nor Cyril's.
  expect(resolve("+33677777777")).toBe("person:bea");
  expect(resolve("cy@example.com")).toBe(self);
  // His word in truth/ settles it: the address is Bea's, whatever the card is called.
  const bea = Person.parse({
    ...truth[0],
    handles: {
      email: ["cy@example.com"],
      phone: ["+33677777777"],
      whatsapp: [],
    },
  });
  expect(foldsOf([bea, cyril], [], [], [mixed]).resolve("cy@example.com")).toBe(
    "person:bea"
  );
});

const ruth = Person.parse({
  birthday: "1980-03-14",
  handles: { email: [], phone: ["+33600000060"], whatsapp: [] },
  id: "ruth",
  name: "Ruth Vale",
});
const withBirthday = (c: ContactNow, birthday: string): ContactNow => ({
  ...c,
  birthday,
});

test("a card under another surname with the directory person's first name and birthday folds into them", () => {
  const c = withBirthday(
    now("card-ruth", "Ruth Marsh", ["+33600000061"]),
    "1980-03-14"
  );
  expect(foldsOf([ruth], [], [], [c]).canon(`person:${c.id}`)).toBe(
    "person:ruth"
  );
  // A card with no year matches a person with one; years that differ do not.
  const noYear = withBirthday(c, "--03-14");
  expect(foldsOf([ruth], [], [], [noYear]).canon(`person:${c.id}`)).toBe(
    "person:ruth"
  );
  const otherYear = withBirthday(c, "1981-03-14");
  expect(foldsOf([ruth], [], [], [otherYear]).canon(`person:${c.id}`)).toBe(
    `person:${c.id}`
  );
  // The same first name with another birthday stays apart.
  const otherDay = withBirthday(c, "1980-03-15");
  expect(foldsOf([ruth], [], [], [otherDay]).canon(`person:${c.id}`)).toBe(
    `person:${c.id}`
  );
});

test("a hyphenated first name is a first name: the first word is taken before the name is normalized", () => {
  const jp = Person.parse({
    birthday: "1975-07-01",
    id: "jean-pierre",
    name: "Jean-Pierre Vale",
  });
  const c = withBirthday(now("card-jp", "Jean-Pierre Marsh", []), "1975-07-01");
  expect(foldsOf([jp], [], [], [c]).canon(`person:${c.id}`)).toBe(
    "person:jean-pierre"
  );
  const jean = withBirthday(now("card-jean", "Jean Marsh", []), "1975-07-01");
  expect(foldsOf([jp], [], [], [jean]).canon(`person:${jean.id}`)).toBe(
    `person:${jean.id}`
  );
});

test("a card whose birthday says one person and whose handle says another is ambiguous; one he ruled out does not fold", () => {
  const c = withBirthday(
    now("card-ruth", "Ruth Marsh", ["+33677777777"]),
    "1980-03-14"
  );
  const self = `person:${c.id}`;
  expect(foldsOf([ruth, ...truth], [], [], [c]).ambiguousCards).toEqual([
    { card: self, people: ["person:bea", "person:ruth"] },
  ]);
  // Two directory people with that first name and birthday: torn too.
  const twin = Person.parse({ ...ruth, id: "ruth-two", name: "Ruth Cole" });
  expect(foldsOf([ruth, twin], [], [], [c]).ambiguousCards).toHaveLength(1);
  const notHer = {
    at: AT,
    kind: "not-this-person",
    nameOrHandle: "+33677777777",
    person: "person:ruth",
    schemaVersion: 1,
  };
  expect(foldsOf([ruth], [], [notHer] as never, [c]).canon(self)).toBe(self);
});

test("a kept card that gains a birthday appends one line, and a second night none", () => {
  const first = after([ANA], [], seenOf(ANA_KEY));
  const born = after([{ ...ANA, birthday: "--05-02" }], first.stored, seenOf());
  expect(born.lines.map((l) => l.birthday)).toEqual(["--05-02"]);
  expect(contactsNow(born.stored)[0]?.birthday).toBe("--05-02");
  expect(
    after([{ ...ANA, birthday: "--05-02" }], born.stored, seenOf()).lines
  ).toEqual([]);
});

test("a card that loses its birthday keeps the one Life held: no line, the person still has it", () => {
  const first = after([{ ...ANA, birthday: "--05-02" }], [], seenOf(ANA_KEY));
  const lost = after([ANA], first.stored, seenOf());
  expect(lost.lines).toEqual([]);
  expect(contactsNow(lost.stored)[0]?.birthday).toBe("--05-02");
});
