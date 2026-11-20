import { expect, test } from "bun:test";
import type { Closeness, Correction } from "../records/observation";
import { latestInUseOf, organizationTestOf } from "./ref-kinds";
import { readPeople } from "./who";

const service = (person: string) =>
  [person, { person, service: true } as Closeness] as const;

test("an organization is his directory's, else its latest inferred record's flag, else a service in closeness unless his closeness word covers it", () => {
  let reads = 0;
  const corrections = [
    { kind: "closeness", person: "person:inf_cafe", personal: "regular" },
  ] as Correction[];
  const isOrganization = organizationTestOf(
    [{ id: "test-bakery" }],
    latestInUseOf([
      { confidence: 0.9, id: "inf_shop", isOrganization: true },
      { confidence: 0.6, id: "inf_kit", isOrganization: true },
      // Its latest record in use decides: a person after all.
      { confidence: 0.6, id: "inf_kit", isOrganization: false },
    ]),
    { canon: (r) => r, corrections },
    () => {
      reads += 1;
      return new Map([service("person:inf_bank"), service("person:inf_cafe")]);
    }
  );
  // The directory and the inferred flag decide without reading closeness.
  expect(isOrganization("person:test-bakery")).toBe(true);
  expect(isOrganization("person:inf_shop")).toBe(true);
  expect(reads).toBe(0);
  expect(isOrganization("person:inf_kit")).toBe(false);
  expect(isOrganization("person:inf_bank")).toBe(true);
  expect(isOrganization("person:inf_cafe")).toBe(false);
  expect(isOrganization("person:test-ana")).toBe(false);
  expect(reads).toBe(1);
});

test("his directory's organization reads by its name, an alias and its own address, is someone he knows and an organization; another address at its domain is not it", async () => {
  const people = await readPeople();
  for (const s of ["Test Bakery", "The Bakery", "hello@bakery.example"]) {
    expect(people.resolve(s)).toBe("person:test-bakery");
  }
  expect(people.resolve("ana@bakery.example")).toBeNull();
  expect(people.isOrganization("person:test-bakery")).toBe(true);
  expect(people.isOrganization("person:test-ana")).toBe(false);
  expect(people.isKnownToHim("person:test-bakery")).toBe(true);
  expect(people.nameOf("person:test-bakery")).toBe("Test Bakery");
  expect(people.relationOf("person:test-bakery")).toBe("where Test Ana works");
});
