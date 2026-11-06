import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { DetailTag, Observation } from "../records/observation";
import type { Person } from "../records/truth";
import type { Contact } from "../sources/contacts";
import { untagged } from "./detail-tags";
import { detailOf, detailsBlock, detailsOf } from "./details";
import { INDEX } from "./ledger";
import { homeOf } from "./page-format";
import { buildIndex, readDetailsOf } from "./search";

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

test("details: his map, then Contacts, then facts newest first; one birthday, the first that gives a date; handles last", () => {
  const lines = detailsOf({
    contacts: [
      contact({
        addresses: ["12 rue Neuve, 44000 Nantes (Home)"],
        birthday: "1990-04-01",
        profiles: ["Facebook: ana.t"],
        work: "Designer, Acme",
      }),
    ],
    facts: [
      {
        date: "2026-01-02",
        detail: "home",
        id: "obs_000000000001",
        text: "Ana moved to Lyon.",
        when: null,
      },
      {
        date: "2026-05-02",
        detail: "diet",
        id: "obs_000000000002",
        text: "Ana is vegetarian.",
        when: null,
      },
      {
        date: "2026-02-02",
        detail: "birthday",
        id: "obs_000000000003",
        text: "Ana's birthday is on 9 May.",
        when: "2026-05-09",
      },
    ],
    person: ana,
  });
  expect(lines.map((l) => [l.kind, l.from])).toEqual([
    ["birthday", "truth"],
    ["home", "contacts"],
    ["home", "obs_000000000001"],
    ["work", "contacts"],
    ["diet", "obs_000000000002"],
    ["handles", "truth"],
    ["handles", "contacts"],
  ]);
  expect(detailsBlock(lines, "2026-03-10")).toEqual([
    "Details:",
    "- Birthday: 12 Mar (in 2 days) (his map)",
    "- Lives in: 12 rue Neuve, 44000 Nantes (Home) (Contacts)",
    "- Lives in: Ana moved to Lyon. (obs_000000000001)",
    "- Work: Designer, Acme (Contacts)",
    "- Diet: Ana is vegetarian. (obs_000000000002)",
    "- Handles: +33611111111 (his map)",
    "- Handles: +33 6 11 11 11 11, Facebook: ana.t (Contacts)",
    "",
  ]);
  // No map birthday: Contacts' wins; none there either: the fact's day, its words kept.
  const fromFact = detailsOf({
    contacts: [],
    facts: [
      {
        date: "2026-02-02",
        detail: "birthday",
        id: "obs_000000000003",
        text: "Ana's birthday is on 9 May.",
        when: "2026-05-09",
      },
    ],
  });
  expect(detailsBlock(fromFact, "2026-05-01")[1]).toBe(
    "- Birthday: Ana's birthday is on 9 May. Next: 9 May (in 8 days) (obs_000000000003)"
  );
  expect(detailsOf({ contacts: [], facts: [] })).toEqual([]);
});

const fact = (id: string, over: Partial<Observation> = {}) =>
  ({
    about: "person:ana",
    area: null,
    at: "2026-10-01T10:00:00.000Z",
    confidence: 0.9,
    date: "2026-10-01",
    entities: ["person:ana"],
    id,
    importance: 2,
    quote: "q",
    source: { channel: "whatsapp", ref: id },
    speaker: "person:ana",
    text: id,
    type: "about_a_person",
    unit: "unit_000000000001",
    unmapped: false,
    when: null,
    ...over,
  }) as unknown as Observation & { unmapped: boolean };

test("details from facts: a replaced address goes, a fact lands only on who it is about, a conditional one is never a detail", () => {
  const old = fact("obs_00000000000a", { text: "Ana lives in Nantes." });
  const moved = fact("obs_00000000000b", { text: "Ana moved to Lyon." });
  const given = fact("obs_00000000000c", {
    entities: ["person:ana", "person:sam"],
    text: "Sam gave Ana a scarf.",
  });
  const maybe = fact("obs_00000000000d", {
    modality: "conditional",
    text: "Ana might move to Paris.",
  });
  const tags = new Map(
    (
      [
        [old.id, "home"],
        [moved.id, "home"],
        [given.id, "gift-given"],
        [maybe.id, "home"],
      ] as const
    ).map(([id, detail]) => [id, { detail, observation: id } as DetailTag])
  );
  const paged = new Set(["person:ana", "person:sam"]);
  const truth = { areas: [], people: [ana], projects: [] } as never;
  mkdirSync(dirname(INDEX), { recursive: true });
  buildIndex(
    [old, moved, given, maybe],
    INDEX,
    {
      corrections: [],
      latest: new Map(),
      live: new Set(["unit_000000000001"]),
      retired: new Map([[old.id, { by: moved.id, observation: old.id }]]),
    } as never,
    [],
    new Date(),
    {
      detail: (o) => detailOf(o, tags),
      home: (o) => homeOf(o as typeof old, truth, paged),
    }
  );
  const detailsFor = readDetailsOf({ resolve: () => null, truth }, []);
  expect(
    detailsFor("person:ana")
      .filter((l) => l.kind !== "birthday" && l.kind !== "handles")
      .map((l) => l.text)
  ).toEqual(["Ana moved to Lyon.", "Sam gave Ana a scarf."]);
  expect(detailsFor("person:sam")).toEqual([]);
  rmSync(INDEX);
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

test("details step: tags facts naming a person, not conditional, not tagged by this prompt; newest first", () => {
  const tagged = { madeBy: { prompt: "memory-details.v1" } } as DetailTag;
  const older = { madeBy: { prompt: "memory-details.v0" } } as DetailTag;
  const list = [
    fact("obs_000000000001", { at: "2026-10-01T00:00:00.000Z" }),
    fact("obs_000000000002", { at: "2026-10-03T00:00:00.000Z" }),
    fact("obs_000000000003", {
      about: "project:house",
      entities: ["project:house"],
    }),
    fact("obs_000000000004", { modality: "conditional" }),
    fact("obs_000000000005"),
    fact("obs_000000000006", { at: "2026-10-02T00:00:00.000Z" }),
  ];
  const tags = new Map([
    ["obs_000000000005", tagged],
    ["obs_000000000006", older],
  ]);
  expect(untagged(list, tags).map((o) => o.id)).toEqual([
    "obs_000000000002",
    "obs_000000000006",
    "obs_000000000001",
  ]);
});
