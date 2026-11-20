import { expect, test } from "bun:test";
import { type Draft, heldOf, mapLinksOf, reconcile } from "./calendar-events";

const draft = (of: string, hash: string) => ({ hash, of }) as Draft;

test("a sync keeps what shows as it is, updates what changed in place, removes a second copy and what is gone", () => {
  const { create, remove, update } = reconcile(
    [draft("m1", "a"), draft("m2", "a"), draft("m3", "new"), draft("m4", "a")],
    new Map([
      ["m1", [{ hash: "a", id: "e1" }]],
      [
        "m2",
        [
          { hash: "a", id: "e2" },
          { hash: "a", id: "e2b" },
        ],
      ],
      ["m3", [{ hash: "old", id: "e3" }]],
      ["m9", [{ hash: "a", id: "e9" }]],
    ])
  );
  expect(create.map((d) => d.of)).toEqual(["m4"]);
  expect(update.map((u) => [u.d.of, u.id])).toEqual([["m3", "e3"]]);
  expect(remove.map((e) => e.id)).toEqual(["e2b", "e9"]);
});

test("an event turning all-day or timed is removed and created again; one whose kind the calendar does not say is updated", () => {
  const { create, remove, update } = reconcile(
    [
      { ...draft("m1", "new"), allDay: true },
      { ...draft("m2", "new"), allDay: true },
    ],
    new Map([
      ["m1", [{ allDay: false, hash: "old", id: "e1" }]],
      ["m2", [{ hash: "old", id: "e2" }]],
    ])
  );
  expect(create.map((d) => d.of)).toEqual(["m1"]);
  expect(remove).toEqual([{ id: "e1", of: "m1" }]);
  expect(update.map((u) => u.id)).toEqual(["e2"]);
});

test("a sync leaves the events `isKept` names though it did not draft them", () => {
  const { remove } = reconcile(
    [],
    new Map([
      ["ep_000000000002", [{ hash: "a", id: "e2" }]],
      ["ep_gone", [{ hash: "a", id: "e9" }]],
    ]),
    (of) => of === "ep_000000000002"
  );
  expect(remove.map((e) => e.id)).toEqual(["e9"]);
});

test("Life's events are grouped by what they show, whichever calendar holds them", () => {
  const held = heldOf([
    { hash: "h1", id: "e1", of: "m1" },
    { hash: "h2", id: "e2", of: "m1" },
    { hash: "h3", id: "e3", of: "m2" },
  ]);
  expect(held.get("m1")).toEqual([
    { hash: "h1", id: "e1" },
    { hash: "h2", id: "e2" },
  ]);
  expect(held.get("m2")).toEqual([{ hash: "h3", id: "e3" }]);
});

test("map links point at the coordinates when Life has them, else at the place's name, URL-encoded; no place, no links", () => {
  expect(
    mapLinksOf({
      latitude: 48.858_37,
      longitude: 2.294_481,
      name: "Tour & Café",
    })
  ).toEqual([
    "Google Maps: https://www.google.com/maps/search/?api=1&query=48.858370,2.294481",
    "Apple Maps: https://maps.apple.com/?q=Tour%20%26%20Caf%C3%A9&ll=48.858370,2.294481",
  ]);
  expect(mapLinksOf({ name: "Le Petit Café, 1 rue Exemple" })).toEqual([
    "Google Maps: https://www.google.com/maps/search/?api=1&query=Le%20Petit%20Caf%C3%A9%2C%201%20rue%20Exemple",
    "Apple Maps: https://maps.apple.com/?q=Le%20Petit%20Caf%C3%A9%2C%201%20rue%20Exemple",
  ]);
  expect(mapLinksOf({ latitude: 1.5, longitude: -2.25, name: null })[1]).toBe(
    "Apple Maps: https://maps.apple.com/?q=1.500000%2C-2.250000&ll=1.500000,-2.250000"
  );
  expect(mapLinksOf({ name: null })).toEqual([]);
});
