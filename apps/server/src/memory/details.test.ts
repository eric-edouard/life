import { expect, test } from "bun:test";
import type { Person } from "../records/truth";
import type { Contact } from "../sources/contacts";
import {
  birthdaysNear,
  birthdayText,
  detailRefOf,
  detailsOf,
  nextBirthday,
  readDetailsOf,
} from "./details";
import { dayLines } from "./read-day";
import { cardOwnerOf } from "./who";

const contact = (over: Partial<Contact> = {}): Contact => ({
  addresses: [],
  birthday: null,
  company: null,
  handles: ["+33 6 11 11 11 11"],
  id: "card-ana",
  labels: {},
  name: "Ana Test",
  profiles: [],
  related: [],
  work: null,
  ...over,
});

const ana = {
  aliases: [],
  birthday: "--03-12",
  handles: { email: [], phone: ["+33611111111"], whatsapp: [] },
  id: "ana",
  name: "Ana",
  projects: [],
} as Person;

test("details: his directory, then Contacts; one birthday (his directory's first); a work address is no home; each handle once; handles last", () => {
  const lines = detailsOf({
    contacts: [
      contact({
        addresses: [
          "12 rue Neuve, 44000 Nantes (Home)",
          "1 quai Ouest, Lyon (Work)",
        ],
        birthday: "1990-04-01",
        // Her phone as his directory has it, written two other ways, and one email in two cases: each shows once.
        handles: [
          "+33 6 11 11 11 11",
          "06 11 11 11 11",
          "Ana@Example.com",
          "ana@example.com",
        ],
        profiles: ["Facebook: ana.t"],
        work: "Designer, Acme",
      }),
    ],
    person: ana,
  });
  expect(lines).toEqual([
    { from: "truth", kind: "birthday", text: "--03-12" },
    {
      from: "contacts",
      kind: "home",
      text: "12 rue Neuve, 44000 Nantes (Home)",
    },
    { from: "contacts", kind: "work", text: "Designer, Acme" },
    { from: "truth", kind: "handles", text: "+33611111111" },
    { from: "contacts", kind: "handles", text: "Ana@Example.com" },
    { from: "contacts", kind: "handles", text: "Facebook: ana.t" },
  ]);
  // No map birthday: Contacts' is the one.
  expect(
    detailsOf({ contacts: [contact({ birthday: "1990-04-01" })] })[0]
  ).toEqual({ from: "contacts", kind: "birthday", text: "1990-04-01" });
  expect(detailsOf({ contacts: [] })).toEqual([]);
  // The same card in two accounts: each line once.
  const card = contact({ addresses: ["5 rue Haute, Lyon"], work: "Pilot" });
  expect(detailsOf({ contacts: [card, card] }).map((l) => l.kind)).toEqual([
    "home",
    "work",
    "handles",
  ]);
});

test("details from Contacts: a record is its owner's (`cardOwnerOf`)", () => {
  const detailsFor = readDetailsOf(
    {
      ownerOfCard: cardOwnerOf({
        canon: (r) => r,
        contacts: [],
        resolve: (h) => (h === "+33 6 11 11 11 11" ? "person:ana" : null),
      }),
      truth: { areas: [], people: [], projects: [] } as never,
    },
    [
      contact({ work: "Designer, Acme" }),
      contact({ handles: ["+1 555 000 0000"], work: "Pilot" }),
    ]
  );
  expect(detailsFor("person:ana").find((l) => l.kind === "work")?.text).toBe(
    "Designer, Acme"
  );
});

test("birthdays: the next date, days left and age; day lists this day and the next 7, soonest first", () => {
  expect(nextBirthday("1993-11-12", "2026-11-09")).toEqual({
    age: 33,
    day: "2026-11-12",
    left: 3,
  });
  // Passed this year: next year's; no year, no age.
  expect(nextBirthday("--01-07", "2026-10-21")).toEqual({
    age: null,
    day: "2027-01-07",
    left: 78,
  });
  expect(birthdayText(nextBirthday("--10-21", "2026-10-21"))).toBe(
    "21 Oct (today)"
  );
  expect(
    birthdaysNear(
      [
        { birthday: "2000-10-28", id: "ana", name: "Ana" },
        { birthday: "--10-21", id: "jean", name: "Jean" },
        { birthday: "--10-29", id: "late", name: "Late" },
        { birthday: null, id: "none", name: "None" },
      ],
      "2026-10-21"
    )
  ).toEqual([
    { id: "jean", name: "Jean", text: "21 Oct (today)" },
    { id: "ana", name: "Ana", text: "28 Oct (in 7 days, turns 26)" },
  ]);
  // 29 Feb falls on 1 Mar in other years.
  expect(nextBirthday("--02-29", "2027-02-28")).toMatchObject({
    day: "2027-03-01",
    left: 1,
  });
  // Across the new year.
  expect(
    birthdaysNear(
      [{ birthday: "--01-02", id: "jan", name: "Jan" }],
      "2026-12-28"
    )
  ).toEqual([{ id: "jan", name: "Jan", text: "2 Jan (in 5 days)" }]);
  // First in `read_day`, before what is due.
  expect(dayLines({ born: ["- born"], due: ["- due"] }).slice(0, 3)).toEqual([
    "Birthdays (this day and the next 7):",
    "- born",
    "",
  ]);
});

test("a work line opens the organization of his directory its company is; a family line, the person its name resolves to", () => {
  const known: Record<string, string> = {
    Anne: "person:anne",
    "Atelier Test": "person:atelier",
    "Atelier Test, Inc.": "person:atelier-inc",
    "Shop Test": "person:shop-test",
  };
  const refOf = detailRefOf({
    isOrganization: (r: string) => r.startsWith("person:atelier"),
    resolve: (name: string) => known[name] ?? null,
    truth: { organizations: [{ id: "atelier" }, { id: "atelier-inc" }] },
  } as unknown as Parameters<typeof detailRefOf>[0]);
  const refs = (over: Partial<Contact>) =>
    detailsOf({ contacts: [contact(over)], refOf }).flatMap((l) =>
      l.kind === "work" || l.kind === "family" ? [[l.text, l.ref ?? null]] : []
    );
  // The company as Contacts holds it, whole: a company holding another's name opens its own.
  expect(
    refs({
      company: "Atelier Test, Inc.",
      work: "Engineer, Atelier Test, Inc.",
    })
  ).toEqual([["Engineer, Atelier Test, Inc.", "person:atelier-inc"]]);
  // A company Life knows but not of his directory, or none: no ref.
  expect(refs({ company: "Shop Test", work: "Baker, Shop Test" })).toEqual([
    ["Baker, Shop Test", null],
  ]);
  expect(refs({ work: "Baker" })).toEqual([["Baker", null]]);
  // The relation's name as Contacts holds it, with or without its label: a name holding ": " is never cut.
  expect(
    refs({
      related: [
        { label: "Mother", name: "Anne" },
        { label: null, name: "Anne" },
        { label: "Mother", name: "Stage: Anne" },
        { label: "Sister", name: "Anne-Marie" },
        { label: "Partner", name: "Atelier Test" },
      ],
    })
  ).toEqual([
    ["Mother: Anne", "person:anne"],
    ["Anne", "person:anne"],
    // A part of a name never counts; an organization is no family.
    ["Mother: Stage: Anne", null],
    ["Sister: Anne-Marie", null],
    ["Partner: Atelier Test", null],
  ]);
});
