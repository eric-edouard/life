import { expect, test } from "bun:test";
import { partyOf, pictureChoicesOf } from "./party";
import { readPeople } from "./who";

// A party, over made-up people: the test data's directory, and made-up pictures.

test("a person in his directory with no relation of their own reads as their role at his organization; the organization is one", async () => {
  const people = await readPeople();
  expect(people.relationOf("person:test-ana")).toBe("baker, Test Bakery");
  expect(people.partyOf("person:test-ana")).toEqual({
    kind: "person",
    line: "baker, Test Bakery",
    name: "Test Ana",
    ref: "person:test-ana",
  });
  expect(people.partyOf("person:test-bakery")).toMatchObject({
    kind: "organization",
    line: "where Test Ana works",
    name: "Test Bakery",
  });
});

test("his pick shows that source's picture; a pick no longer shown falls back to the first; `none` shows none", () => {
  const party = partyOf(
    {
      isOrganization: () => false,
      nameOf: (r) => r.replace("person:", ""),
      refOf: (r) => (r === "person:old" ? "person:kim" : r),
      relationOf: () => null,
    },
    [
      { id: "kim", pictureFrom: "whatsapp" },
      { id: "lee", pictureFrom: "instagram" },
      { id: "max", pictureFrom: "none" },
    ],
    () => ({
      "person:kim": [
        { id: "k1", source: "contacts" },
        { id: "k2", source: "whatsapp" },
      ],
      "person:lee": [{ id: "l1", source: "contacts" }],
      "person:max": [{ id: "m1", source: "contacts" }],
      "person:noa": [{ id: "n1", source: "imessage" }],
    })
  );
  // A folded ref reads as who it is now, with their picture.
  expect(party("person:old")).toEqual({
    kind: "person",
    name: "kim",
    picture: { id: "k2" },
    ref: "person:kim",
  });
  expect(party("person:lee").picture).toEqual({ id: "l1" });
  expect(party("person:max").picture).toBeUndefined();
  expect(party("person:noa").picture).toEqual({ id: "n1" });
  expect(party("person:zed").picture).toBeUndefined();
});

test("he picks from the first picture of each source, only for someone of his directory", () => {
  const choicesOf = pictureChoicesOf([{ id: "kim" }], () => ({
    "person:kim": [
      { id: "k1", source: "contacts" },
      { id: "k2", source: "whatsapp" },
      { id: "k3", source: "whatsapp" },
    ],
    "person:noa": [{ id: "n1", source: "imessage" }],
  }));
  expect(choicesOf("person:kim")).toEqual([
    { id: "k1", source: "contacts" },
    { id: "k2", source: "whatsapp" },
  ]);
  // Outside his directory no pick can be written: nothing to pick from.
  expect(choicesOf("person:noa")).toEqual([]);
});
