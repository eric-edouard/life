import { expect, test } from "bun:test";
import { heldOf } from "./past-calendar";

test("Life's events are found by moment, whichever calendar holds them", () => {
  const held = heldOf([
    { hash: "h1", id: "e1", moment: "m1" },
    { hash: "h2", id: "e2", moment: "m1" },
    { hash: "h3", id: "e3", moment: "m2" },
  ]);
  expect(held.get("m1")).toEqual([
    { hash: "h1", id: "e1" },
    { hash: "h2", id: "e2" },
  ]);
  expect(held.get("m2")).toEqual([{ hash: "h3", id: "e3" }]);
});
