import { expect, test } from "bun:test";
import { type Draft, heldOf, reconcile } from "./calendar-events";

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
