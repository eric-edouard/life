import { afterAll, beforeAll, expect, test } from "bun:test";
import { setSettings, settings } from "../core/settings";
import {
  type InferredPerson,
  peopleOutsideDirectoryOf,
} from "../records/observation";
import { Organization, Person, Project } from "../records/truth";
import {
  emailNameOf,
  emailsOf,
  emailsShown,
  involvedOf,
  refContext,
} from "./model-context";
import type { Truth } from "./read-truth";

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
        organizations: [],
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

const directoryOf = (
  outsideDirectory: ReturnType<typeof peopleOutsideDirectoryOf>,
  people: ReturnType<typeof Person.parse>[],
  canon = (ref: string) => ref
) => ({
  canon,
  outsideDirectory,
  truth: {
    areas: [],
    chats: [],
    me: { text: "me" },
    organizations: [] as ReturnType<typeof Organization.parse>[],
    people,
    projects: [] as Truth["projects"],
  },
});

test("an organization is in the models' directory like a person, and a project that names it reads its name", () => {
  const inputs = directoryOf([], [Person.parse({ id: "me", name: "Me" })]);
  inputs.truth.organizations = [
    Organization.parse({
      handles: { email: ["hello@bakery.example"] },
      id: "test-bakery",
      name: "Test Bakery",
      relation: "his client",
    }),
  ];
  inputs.truth.projects = [
    {
      ...Project.parse({
        area: "work",
        id: "shop",
        name: "Shop",
        people: ["test-bakery"],
        schemaVersion: 1,
        status: "active",
      }),
      notes: "",
    },
  ];
  const { directory } = refContext(inputs, new Set(), new Set());
  expect(directory.people.map((p) => [p.ref, p.relation])).toEqual([
    ["person:me", undefined],
    ["person:test-bakery", "his client"],
  ]);
  expect(directory.projects[0]?.people).toEqual(["Test Bakery"]);
  expect(emailsOf(inputs).get("person:test-bakery")).toEqual([
    "hello@bakery.example",
  ]);
});

test("addresses come only to the episodes call: with a person's emails, and none for one without", () => {
  const inputs = directoryOf(
    peopleOutsideDirectoryOf(
      [
        {
          handles: ["+33600000009", "dee@mail.example"],
          id: "con_dee",
          name: "Dee",
        },
      ],
      []
    ),
    [
      Person.parse({
        handles: { email: ["ann@mail.example"] },
        id: "ann",
        name: "Ann",
      }),
      Person.parse({ id: "bob", name: "Bob" }),
    ]
  );
  const refs = refContext(inputs, new Set(), new Set());
  const shown = emailsShown(refs.directory.people, emailsOf(inputs));
  expect(shown.map((p) => [p.ref, "emails" in p ? p.emails : null])).toEqual([
    ["person:ann", ["ann@mail.example"]],
    ["person:bob", null],
    ["person:con_dee", ["dee@mail.example"]],
  ]);
  // The context and the input every other call reads carry none.
  expect(JSON.stringify(refs.context)).not.toContain("@");
  expect(JSON.stringify(refs.directory)).not.toContain("@");
});

test("a Matrix id is no address; a card folded into a person gives them its addresses; an address spelling a name resolves it", () => {
  const emails = emailsOf(
    directoryOf(
      peopleOutsideDirectoryOf(
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
      [Person.parse({ id: "ann", name: "Ann" })],
      (ref) => (ref === "person:con_bee" ? "person:ann" : ref)
    )
  );
  expect(emails.get("person:ann")).toEqual(["annmarie123@mail.example"]);
  expect(emails.has("person:inf_line")).toBe(false);
  const named = emailNameOf(emails);
  expect(named("Anne Marie")).toBeNull();
  expect(named("Ann-Marie")).toBe("person:ann");
  // Fewer than 4 letters is no name.
  expect(
    emailNameOf(new Map([["person:jo", ["jo1@x.example"]]]))("Jo")
  ).toBeNull();
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
        organizations: [],
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
          organizations: [],
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
