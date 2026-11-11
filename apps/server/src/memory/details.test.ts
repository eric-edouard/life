import { expect, test } from "bun:test";
import type { Person } from "../records/truth";
import type { Contact } from "../sources/contacts";
import {
  birthdaysNear,
  birthdayText,
  detailsBlock,
  detailsOf,
  nextBirthday,
  readDetailsOf,
} from "./details";
import { dayLines } from "./read-day";

const contact = (over: Partial<Contact> = {}): Contact => ({
  addresses: [],
  birthday: null,
  handles: ["+33 6 11 11 11 11"],
  id: "card-ana",
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

test("details: his map, then Contacts; one birthday (his map's first); a work address is no home; each handle once; handles last", () => {
  const lines = detailsOf({
    contacts: [
      contact({
        addresses: [
          "12 rue Neuve, 44000 Nantes (Home)",
          "1 quai Ouest, Lyon (Work)",
        ],
        birthday: "1990-04-01",
        // Her phone as his map has it, written two other ways, and one email in two cases: each shows once.
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
  expect(detailsBlock(lines, "2026-03-10")).toEqual([
    "Details:",
    "- Birthday: 12 Mar (in 2 days) (his map)",
    "- Lives in: 12 rue Neuve, 44000 Nantes (Home) (Contacts)",
    "- Work: Designer, Acme (Contacts)",
    "- Handles: +33611111111 (his map)",
    "- Handles: Ana@Example.com, Facebook: ana.t (Contacts)",
    "",
  ]);
  // No map birthday: Contacts' is the one, with her age.
  expect(
    detailsBlock(
      detailsOf({ contacts: [contact({ birthday: "1990-04-01" })] }),
      "2026-03-10"
    )[1]
  ).toBe("- Birthday: 1 Apr (in 22 days, turns 36) (Contacts)");
  expect(detailsOf({ contacts: [] })).toEqual([]);
  // The same card in two accounts: each line once.
  const card = contact({ addresses: ["5 rue Haute, Lyon"], work: "Pilot" });
  expect(detailsOf({ contacts: [card, card] }).map((l) => l.kind)).toEqual([
    "home",
    "work",
    "handles",
  ]);
});

test("details from Contacts: a record is the person one of its handles resolves to", () => {
  const detailsFor = readDetailsOf(
    {
      resolve: (h) => (h === "+33 6 11 11 11 11" ? "person:ana" : null),
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
