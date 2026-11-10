import { expect, test } from "bun:test";
import { newestDays, packed } from "./lists";

test("person pages back by whole days: a day is never cut, and `next` is the day to page back from", () => {
  const items = [
    "2026-10-20",
    "2026-10-19",
    "2026-10-19",
    "2026-10-18",
    "2026-10-17",
  ];
  const day = (d: string) => d;
  expect(newestDays(items, day, 2)).toEqual({
    next: "2026-10-19",
    taken: ["2026-10-20", "2026-10-19", "2026-10-19"],
  });
  expect(newestDays(items, day, 2, "2026-10-19")).toEqual({
    next: undefined,
    taken: ["2026-10-18", "2026-10-17"],
  });
  expect(newestDays(items, day, 9)).toEqual({ next: undefined, taken: items });
  expect(newestDays(items, day, 2, "2026-10-17")).toEqual({
    next: undefined,
    taken: [],
  });
});

test("packed: runs within the budget, in order; an item over it sits alone; nothing gives nothing", () => {
  const same = (n: number) => n;
  expect(packed([60, 50, 10], 100, same)).toEqual([[60], [50, 10]]);
  expect(packed([60, 40, 1], 100, same)).toEqual([[60, 40], [1]]);
  expect(packed([150, 10, 90], 100, same)).toEqual([[150], [10, 90]]);
  expect(packed([], 100, same)).toEqual([]);
});
