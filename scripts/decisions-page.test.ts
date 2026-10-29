import { expect, test } from "bun:test";
import {
  isOpen,
  nextOpen,
  orderOf,
  tapAnswer,
  // @ts-expect-error: the page's own script, plain JavaScript served as is (assets/decisions/decisions.js)
} from "../assets/decisions/decisions.js";

const d = (id: string, loop: string, extra: object = {}) => ({
  id,
  loop,
  options: [{ id: "a", label: "A" }],
  status: "open",
  ...extra,
});

test("his decisions page: loops in his goals' order (one with nothing left open goes last), each by deadline; answering moves to the next one still his", () => {
  const all = [
    d("x2", "lynx", { deadline: "2026-11-02", rank: 3 }),
    d("x1", "lynx", { deadline: "2026-11-01", rank: 3 }),
    d("m1", "mad", { rank: 2 }),
    d("old", "mad", { closedAt: "2026-10-29", status: "done" }),
    d("a1", "daily", { answer: "a", rank: 0, status: "answered" }),
  ];
  const groups = orderOf(all);
  expect(groups.map((g: { loop: string }) => g.loop)).toEqual([
    "mad",
    "lynx",
    "daily",
  ]);
  const live = groups.flatMap((g: { live: { id: string }[] }) => g.live);
  expect(live.map((l: { id: string }) => l.id)).toEqual([
    "m1",
    "x1",
    "x2",
    "a1",
  ]);
  expect(isOpen(all[4])).toBe(false);
  expect(nextOpen(live, "m1")?.id).toBe("x1");
  expect(nextOpen(live, "a1")?.id).toBe("m1"); // wraps round
  expect(nextOpen(live, "x2")?.id).toBe("m1"); // skips what he answered
  expect(nextOpen([live[3]], "a1")).toBeUndefined();
  expect(tapAnswer({ answer: "a" }, "a", "")).toBeNull(); // tapping the chosen one takes it back
});
