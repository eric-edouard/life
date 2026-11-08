import { expect, test } from "bun:test";
import type { Person } from "../records/truth";
import type { Contact } from "../sources/contacts";
import { detailsBlock, detailsOf } from "./details";
import { readDetailsOf } from "./search";

const contact = (over: Partial<Contact> = {}): Contact => ({
  addresses: [],
  birthday: null,
  handles: ["+33 6 11 11 11 11"],
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
