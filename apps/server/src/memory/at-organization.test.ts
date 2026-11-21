import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { Organization, Person } from "../records/truth";
import * as contacts from "../sources/contacts";
import { answerCheck } from "./answer-check";
import {
  atOrganizationPairOf,
  atOrganizationPairsOf,
  atOrganizationRefOf,
} from "./at-organization";
import { urgencyOf } from "./check-urgency";
import { checksOf, type InboxCheck } from "./checks";
import { about, inputs } from "./checks-test-inputs";
import { CORRECTIONS, readCorrections } from "./memory-files";
import { said } from "./record-fixtures";

// Made-up people: someone of his directory whose Contacts card names an organization of his directory (life#874).

const lou = Person.parse({ id: "lou", name: "Lou Martin" });
const garage = Organization.parse({
  aliases: ["The Garage"],
  id: "test-garage",
  name: "Test Garage",
});
const card = (company: string | null, work: string | null) =>
  ({
    company,
    handles: [],
    id: "card-lou",
    work,
  }) as unknown as contacts.Contact;
const pairsOf = (
  cards: contacts.Contact[],
  over: { corrections?: ReturnType<typeof said>[]; members?: string[] } = {}
) =>
  atOrganizationPairsOf(
    {
      canon: (r) => r,
      corrections: over.corrections ?? [],
      isOrganization: (r) => r === "person:test-garage",
      resolve: () => null,
      truth: {
        organizations: [
          {
            ...garage,
            people: (over.members ?? []).map((id) => ({ id, role: "x" })),
          },
        ],
        people: [lou],
      },
    } as never,
    (ref) => (ref === "person:lou" ? cards : [])
  );

test("a Contacts card naming an organization of his directory, by its name or an alias, with a job title: one pair, its role the title, its ref bound to both", () => {
  expect(
    pairsOf([card("The Garage", "Mechanic, Workshop, The Garage")])
  ).toEqual([
    {
      evidence: "Their Contacts card says “Mechanic, Workshop, The Garage”.",
      organization: "person:test-garage",
      person: "person:lou",
      role: "Mechanic, Workshop",
    },
  ]);
  expect(
    atOrganizationPairOf(
      atOrganizationRefOf("person:test-garage", "person:lou")
    )
  ).toEqual({ organization: "person:test-garage", person: "person:lou" });
});

test("never asked: no title, a company that is no organization of his, someone already there (or who left), a pair his No refused", () => {
  expect(pairsOf([card("Test Garage", "Test Garage")])).toEqual([]);
  expect(pairsOf([card("Other Garage", "Mechanic, Other Garage")])).toEqual([]);
  const mechanic = [card("Test Garage", "Mechanic, Test Garage")];
  expect(pairsOf(mechanic, { members: ["lou"] })).toEqual([]);
  const no = said({
    kind: "not-at-organization",
    organization: "person:test-garage",
    person: "person:lou",
  });
  expect(pairsOf(mechanic, { corrections: [no] })).toEqual([]);
});

test("the card: asked while the person matters, with the role it writes; it improves, never blocks", () => {
  const pair = {
    evidence: "Their Contacts card says “Mechanic, Test Garage”.",
    organization: "person:test-garage",
    person: "person:dana",
    role: "Mechanic",
  };
  const asked = checksOf(
    inputs([about("person:dana")], { atOrganizations: [pair] })
  ).filter((x) => x.group === "at organization");
  expect(
    asked.map((x) => [
      x.ref,
      x.question,
      x.options.map((o) => o.id),
      urgencyOf(x),
    ])
  ).toEqual([
    [
      atOrganizationRefOf("person:test-garage", "person:dana"),
      "Is Dana at person:test-garage as Mechanic?",
      ["yes", "not-at-organization"],
      "improves",
    ],
  ]);
  expect(asked[0]?.context).toBe(pair.evidence);
  expect(
    checksOf(inputs([about("person:x")], { atOrganizations: [pair] })).filter(
      (x) => x.group === "at organization"
    )
  ).toEqual([]);
});

// The test data's owner (owner@example.com) and Test Bakery; his card says he is its owner.
const ref = atOrganizationRefOf("person:test-bakery", "person:me");
const asked = {
  about: [],
  group: "at organization",
  kind: "person",
  ref,
} as unknown as InboxCheck;
beforeEach(() => {
  rmSync(CORRECTIONS, { force: true });
  spyOn(contacts, "readContactRecords").mockReturnValue([
    {
      ...card("Test Bakery", "Owner, Test Bakery"),
      handles: ["owner@example.com"],
      id: "card-me",
    },
  ]);
});
afterEach(() => rmSync(CORRECTIONS, { force: true }));

test("Yes adds the link through his directory's door, only on his own answer_check; No is kept, so the pair is never asked again", async () => {
  await expect(
    answerCheck(asked, { options: ["yes"] }, "session")
  ).rejects.toThrow("only through his own answer_check");
  const added: string[][] = [];
  await answerCheck(asked, { options: ["yes"] }, "connector", {
    addOrganizationPerson: (...a) => {
      added.push(a);
      return Promise.resolve("Done");
    },
  });
  expect(added).toEqual([["person:test-bakery", "person:me", "Owner"]]);
  await answerCheck(asked, { options: ["not-at-organization"] }, "session");
  expect(
    readCorrections().map(({ at: _a, schemaVersion: _v, ...c }) => c)
  ).toEqual([
    {
      kind: "not-at-organization",
      organization: "person:test-bakery",
      person: "person:me",
    },
  ]);
  await expect(
    answerCheck(asked, { options: ["not-at-organization"] }, "session")
  ).rejects.toThrow(`no open check ${ref}`);
});
