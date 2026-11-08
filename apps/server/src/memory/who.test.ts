import { expect, test } from "bun:test";
import { candidateLines } from "./read-person-page";
import { meant, namedLike, nearNames } from "./who";

test("person: a name two people go by lists both, with relation and count", () => {
  const people = [
    {
      aliases: ["Claire"],
      id: "claire",
      name: "Claire Dupont",
      relation: "half-sister",
    },
    {
      aliases: ["Claire"],
      id: "claire-friend",
      name: "Claire (friend)",
      relation: "ex (casual), friend",
    },
    {
      aliases: ["Zoé"],
      id: "zoe",
      name: "Zoé Dupont",
      relation: "half-sister",
    },
  ];
  const matches = namedLike("claire", people);
  expect(matches.map((p) => p.id)).toEqual(["claire", "claire-friend"]);
  expect(namedLike("claire-friend", people)).toHaveLength(1);
  expect(namedLike("Zoe", people)).toHaveLength(1);
  const lines = candidateLines("claire", matches, (id) =>
    id === "claire" ? 4 : 9
  );
  expect(lines).toContain(
    "- claire: Claire Dupont, half-sister, 4 observations"
  );
  expect(lines).toContain(
    "- claire-friend: Claire (friend), ex (casual), friend, 9 observations"
  );
  expect(candidateLines("zoe", namedLike("zoe", people), () => 0)).toEqual([]);
});

test("person: a misheard or misspelled name lists the names near it, never a guess", () => {
  const people = [
    { aliases: ["Joel", "Joël"], id: "joel", name: "Joël Marchand" },
    { aliases: [], id: "noel", name: "Noel" },
    { aliases: ["Ines"], id: "ines", name: "Inès Fabre" },
  ];
  expect(nearNames("Joelle", people).map((p) => p.id)).toEqual(["joel"]);
  expect(nearNames("Jowl", people).map((p) => p.id)).toEqual(["joel"]);
  expect(nearNames("Joël Marchant", people).map((p) => p.id)).toEqual(["joel"]);
  expect(nearNames("Joe", people).map((p) => p.id)).toEqual(["joel"]);
  // A name of four letters or fewer allows one edit only: "Nil" is two from "Noel".
  expect(nearNames("Nil", people)).toEqual([]);
  expect(nearNames("Zebulon", people)).toEqual([]);
});

test("a name means who it resolves to, listed first among those going by it; a name nothing resolves means no one", () => {
  const people = [
    { aliases: ["Claire"], id: "claire", name: "Claire Dupont" },
    { aliases: ["Claire"], id: "claire-friend", name: "Claire (friend)" },
    { aliases: [], id: "ann", name: "Ann Kerr" },
  ];
  const mean = (name: string, resolve: (s: string) => string | null) =>
    meant(name, {
      canon: (r: string) => r,
      inferred: [],
      resolve,
      truth: { people } as never,
    });
  const ids = (m: ReturnType<typeof mean>) => [
    m.known,
    m.same.map((p) => p.id),
  ];
  // He said this Claire is his friend (`this-is`): she is the one, listed first.
  expect(
    ids(mean("Claire", (s) => (s === "Claire" ? "person:claire-friend" : null)))
  ).toEqual(["claire-friend", ["claire-friend", "claire"]]);
  expect(ids(mean("Claire", () => null))).toEqual([
    "claire",
    ["claire", "claire-friend"],
  ]);
  // A name he said is Ann: she is meant and listed first, though she goes by another name.
  expect(ids(mean("Claire", () => "person:ann"))).toEqual([
    "ann",
    ["ann", "claire", "claire-friend"],
  ]);
  expect(ids(mean("Clai", () => null))).toEqual([undefined, []]);
});
