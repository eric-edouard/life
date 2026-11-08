import { expect, test } from "bun:test";
import { newestDays } from "./lists";

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
