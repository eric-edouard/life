import { expect, test } from "bun:test";
import type { DecisionRow } from "@life/server/src/records/decision";
import { isOpen, keyDown, nextOpen, orderOf, tapAnswer } from "./order";

const d = (
  id: string,
  loop: string,
  extra: Partial<DecisionRow> = {}
): DecisionRow => ({
  createdAt: "2026-10-28T10:00:00.000Z",
  id,
  loop,
  options: [{ id: "a", label: "A" }],
  question: id,
  status: "open",
  ...extra,
});

test("his decisions page: loops in his goals' order (one with nothing left open goes last), each by deadline; answering moves to the next one still his", () => {
  const all = [
    d("x2", "lynx", { deadline: "2026-11-02T00:00:00.000Z", rank: 3 }),
    d("x1", "lynx", { deadline: "2026-11-01T00:00:00.000Z", rank: 3 }),
    d("m1", "mad", { rank: 2 }),
    d("old", "mad", { closedAt: "2026-10-29T00:00:00.000Z", status: "done" }),
    d("a1", "daily", { answer: "a", rank: 0, status: "answered" }),
  ];
  const groups = orderOf(all);
  expect(groups.map((g) => g.loop)).toEqual(["mad", "lynx", "daily"]);
  const live = groups.flatMap((g) => g.live);
  expect(live.map((l) => l.id)).toEqual(["m1", "x1", "x2", "a1"]);
  expect(isOpen(d("req", "asks", { options: [] }))).toBe(false); // his own request has nothing to answer
  expect(nextOpen(live, "m1")?.id).toBe("x1");
  expect(nextOpen(live, "a1")?.id).toBe("m1"); // wraps round
  expect(nextOpen(live, "x2")?.id).toBe("m1"); // skips what he answered
  expect(nextOpen([d("a1", "daily", { answer: "a" })], "a1")).toBeUndefined();
  expect(
    tapAnswer({ answer: "a", options: [], status: "answered" }, "a", "")
  ).toBeNull(); // tapping the chosen one takes it back
});

test("a key other than Escape reaches his answer (30 Oct: every key was cancelled, typing did nothing)", () => {
  const closed: string[] = [];
  expect(keyDown({ key: "a" }, () => closed.push("closed"))).toBeUndefined();
  expect(closed).toEqual([]);
  keyDown({ key: "Escape" }, () => closed.push("closed"));
  expect(closed).toEqual(["closed"]);
});
