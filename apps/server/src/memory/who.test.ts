import { expect, test } from "bun:test";
import { candidateLines } from "./read-person-page";
import { inferred, people as mapped, said } from "./record-fixtures";
import { foldsOf, meant, namedLike, nearNames } from "./who";

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
      beyond: [],
      canon: (r: string) => r,
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

test("names resolve cheapest first: handles, then names and aliases, else nothing", () => {
  const { resolve } = foldsOf(mapped, [], [], []);
  expect(resolve("+66600000001")).toBe("person:dad");
  expect(resolve("pops")).toBe("person:dad");
  expect(resolve("Jean (Me)")).toBe("person:me");
  expect(resolve("Annesophie")).toBeNull();
});

test("a surface resolves to what the owner said, else truth, else a confident inferred person, never against a correction", () => {
  const inferredPeople = [
    inferred("inf_plumber", ["+33611111111", "Plombier"]),
    inferred("inf_maybe", ["+33622222222"], 0.3),
  ];
  const { resolve } = foldsOf(
    mapped,
    inferredPeople,
    [
      said({
        kind: "this-is",
        person: "person:gaston",
        surface: "+33633333333",
      }),
      said({ kind: "not-this-person", person: "person:dad", surface: "Pops" }),
      said({
        from: "person:inf_plumber",
        kind: "same-person",
        to: "person:gaston",
      }),
    ],
    []
  );
  expect(resolve("+33633333333")).toBe("person:gaston");
  expect(resolve("+66600000001")).toBe("person:dad");
  // The model's guess is used, and folded into the person the owner says it is.
  expect(resolve("plombier")).toBe("person:gaston");
  expect(resolve("+33622222222")).toBeNull();
  expect(resolve("Pops")).toBeNull();
  expect(foldsOf(mapped, inferredPeople, [], []).resolve("plombier")).toBe(
    "person:inf_plumber"
  );
  expect(
    foldsOf(
      [],
      [],
      [said({ from: "person:a", kind: "same-person", to: "person:a" })],
      []
    ).canon("person:a")
  ).toBe("person:a");
});

test("a surface the call linked to someone in truth/ is them, and so is every guess going by it, until he says otherwise", () => {
  const linked = (confidence: number) => ({
    ...inferred("inf_gas-1", ["Gas B"], confidence),
    person: "person:gaston",
  });
  // An older guess for the same surface, with a page of its own: the newest confident answer decides.
  const older = inferred("inf_gas", ["Gas B", "+33644444444"]);
  const both = [older, linked(0.6)];
  expect(foldsOf(mapped, both, [], []).resolve("Gas B")).toBe("person:gaston");
  expect(foldsOf([], both, [], []).canon("person:inf_gas")).toBe(
    "person:gaston"
  );
  expect(foldsOf(mapped, both, [], []).resolve("+33644444444")).toBe(
    "person:gaston"
  );
  // Unsure, the link is not used; a newer confident answer with no link takes it back, and every id the surface was
  // given reads as that answer (one surface, one person).
  expect(
    foldsOf([], [older, linked(0.4)], [], []).canon("person:inf_gas")
  ).toBe("person:inf_gas");
  const unlinked = foldsOf(
    [],
    [older, linked(0.6), inferred("inf_gas-2", ["Gas B"])],
    [],
    []
  ).canon;
  expect(unlinked("person:inf_gas")).toBe("person:inf_gas-2");
  expect(unlinked("person:inf_gas-1")).toBe("person:inf_gas-2");
  // His word on the surface beats the link.
  const not = said({
    kind: "not-this-person",
    person: "person:gaston",
    surface: "Gas B",
  });
  expect(foldsOf([], both, [not], []).canon("person:inf_gas")).toBe(
    "person:inf_gas-1"
  );
  expect(foldsOf(mapped, both, [not], []).resolve("Gas B")).toBe(
    "person:inf_gas-1"
  );
  // A surface that is a name on the map reads as them, and so does a guess made for it before.
  expect(
    foldsOf(mapped, [inferred("inf_gaston-x", ["Gaston"])], [], []).canon(
      "person:inf_gaston-x"
    )
  ).toBe("person:gaston");
});
