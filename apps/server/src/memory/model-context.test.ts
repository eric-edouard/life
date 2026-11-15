import { expect, test } from "bun:test";
import {
  type InferredPerson,
  peopleOutsideDirectoryOf,
} from "../records/observation";
import { Person, Project } from "../records/truth";
import { involvedOf, refContext } from "./model-context";

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
