import { afterAll, beforeAll, expect, test } from "bun:test";
import { setSettings, settings } from "../core/settings";
import {
  type InferredPerson,
  peopleOutsideDirectoryOf,
} from "../records/observation";
import { Person, Project } from "../records/truth";
import {
  emailNamedIn,
  emailsShown,
  involvedOf,
  refContext,
} from "./model-context";

const was = settings().personal;
// His install: the relationships add-on on.
beforeAll(() => setSettings({ personal: { relationships: {} } }));
afterAll(() => setSettings({ personal: was ?? null }));

test("a call's context shows the people close now and the projects underway; the rest of the directory comes as involved", () => {
  const person = (id: string) => Person.parse({ id, name: id.toUpperCase() });
  const project = (id: string, status: Project["status"]) => ({
    ...Project.parse({ area: "work", id, name: id, schemaVersion: 1, status }),
    notes: "",
  });
  const refs = refContext(
    {
      canon: (ref) => ref,
      outsideDirectory: [],
      truth: {
        areas: [],
        chats: [],
        me: { text: "me" },
        people: [person("ann"), person("bob"), person("cy")],
        projects: [project("app", "active"), project("old", "done")],
      },
    },
    new Set(["person:bob"]),
    new Set(["person:ann"])
  );
  expect(refs.context.people.map((p) => p.ref)).toEqual(["person:ann"]);
  expect(refs.context.projects.map((p) => p.ref)).toEqual(["project:app"]);
  expect(refs.directory.people.map((p) => p.ref)).toEqual([
    "person:ann",
    "person:bob",
    "person:cy",
  ]);
  const involved = involvedOf(
    refs,
    new Set(["person:ann", "person:bob", "project:old", "person:nobody"])
  );
  expect(involved.people.map((p) => [p.ref, p.close])).toEqual([
    ["person:bob", true],
  ]);
  expect(involved.projects.map((p) => [p.ref, p.status])).toEqual([
    ["project:old", "done"],
  ]);
});

test("addresses come only to the episodes call: with a person's emails, and none for one without", () => {
  const refs = refContext(
    {
      canon: (ref) => ref,
      outsideDirectory: peopleOutsideDirectoryOf(
        [
          {
            handles: ["+33600000009", "dee@mail.example"],
            id: "con_dee",
            name: "Dee",
          },
        ],
        []
      ),
      truth: {
        areas: [],
        chats: [],
        me: { text: "me" },
        people: [
          Person.parse({
            handles: { email: ["ann@mail.example"] },
            id: "ann",
            name: "Ann",
          }),
          Person.parse({ id: "bob", name: "Bob" }),
        ],
        projects: [],
      },
    },
    new Set(),
    new Set()
  );
  const shown = emailsShown(refs.directory.people, refs);
  expect(shown.map((p) => [p.ref, "emails" in p ? p.emails : null])).toEqual([
    ["person:ann", ["ann@mail.example"]],
    ["person:bob", null],
    ["person:con_dee", ["dee@mail.example"]],
  ]);
  // The context and the input every other call reads carry none.
  expect(JSON.stringify(refs.context)).not.toContain("@");
  expect(JSON.stringify(refs.directory)).not.toContain("@");
});

test("a Matrix id is no address; a card folded into a person gives them its addresses; an address spelling a name the day writes brings the person in", () => {
  const refs = refContext(
    {
      canon: (ref) => (ref === "person:con_bee" ? "person:ann" : ref),
      outsideDirectory: peopleOutsideDirectoryOf(
        [
          {
            handles: ["annmarie123@mail.example", "+33600000009"],
            id: "con_bee",
            name: "Bee",
          },
        ],
        [
          {
            confidence: 0.9,
            id: "inf_line",
            name: "Kit",
            namesAndHandles: ["@line__u91_abc:beeper.local"],
            relation: "friend",
          } as InferredPerson,
        ]
      ),
      truth: {
        areas: [],
        chats: [],
        me: { text: "me" },
        people: [Person.parse({ id: "ann", name: "Ann" })],
        projects: [],
      },
    },
    new Set(),
    new Set()
  );
  expect(refs.emails.get("person:ann")).toEqual(["annmarie123@mail.example"]);
  expect(refs.emails.has("person:inf_line")).toBe(false);
  expect([...emailNamedIn(["Dear Mrs Anne Marie,"], refs)]).toEqual([]);
  expect([...emailNamedIn(["Dear Mrs Ann-Marie, thanks"], refs)]).toEqual([
    "person:ann",
  ]);
  // Fewer than 4 letters is no name.
  expect(
    emailNamedIn(["Jo"], {
      emails: new Map([["person:jo", ["jo1@x.example"]]]),
    }).size
  ).toBe(0);
});

test("the directory shows each person once: an inferred id folded into another is left out", () => {
  const guess = (id: string) =>
    ({
      confidence: 0.9,
      id,
      name: id,
      namesAndHandles: [id],
      relation: "a guess",
    }) as InferredPerson;
  const refs = refContext(
    {
      canon: (ref) => (ref === "person:inf_ann" ? "person:ann" : ref),
      outsideDirectory: peopleOutsideDirectoryOf(
        [],
        [guess("inf_ann"), guess("inf_dee")]
      ),
      truth: {
        areas: [],
        chats: [],
        me: { text: "me" },
        people: [Person.parse({ id: "ann", name: "Ann" })],
        projects: [],
      },
    },
    new Set(),
    new Set()
  );
  expect(refs.directory.people.map((p) => p.ref)).toEqual([
    "person:ann",
    "person:inf_dee",
  ]);
});

test("no one is flagged close while the relationships add-on is off", () => {
  const refs = () =>
    refContext(
      {
        canon: (r) => r,
        outsideDirectory: [],
        truth: {
          areas: [],
          chats: [],
          me: { text: "me" },
          people: [Person.parse({ id: "bob", name: "Bob" })],
          projects: [],
        },
      },
      new Set(["person:bob"]),
      new Set(["person:bob"])
    );
  const ref = () => refs().context.people;
  try {
    expect(refs().close.size).toBe(1);
    expect(ref()).toEqual([expect.objectContaining({ close: true })]);
    setSettings({ personal: { aboutMe: {} } });
    expect(refs().close.size).toBe(0);
    expect(ref().map((p) => "close" in p)).toEqual([false]);
  } finally {
    setSettings({ personal: { relationships: {} } });
  }
});
