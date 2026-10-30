import { expect, test } from "bun:test";
import type { DecisionRow } from "@life/server/src/records/decision";
import {
  currentOf,
  DONE,
  isOpen,
  moveOf,
  nextOpen,
  noteAnswer,
  orderOf,
  tapAnswer,
} from "./order";

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

test("only the arrows move, never while he types, and no key is taken from him (30 Oct: every key was cancelled, typing did nothing)", () => {
  expect(moveOf("ArrowRight", null)).toBe(1);
  expect(moveOf("ArrowLeft", null)).toBe(-1);
  expect(moveOf("a", null)).toBe(0);
  expect(moveOf("Escape", null)).toBe(0);
});

test("the decision on screen: the link's while it is live, the end only once nothing is open, else the first open one", () => {
  const open = d("o1", "lynx");
  const answered = d("a1", "lynx", { answer: "a", status: "answered" });
  expect(currentOf([answered, open], "a1")).toBe("a1");
  expect(currentOf([answered, open], "closed-one")).toBe("o1");
  expect(currentOf([answered, open], DONE)).toBe("o1"); // a new one came in
  expect(currentOf([answered], DONE)).toBe(DONE);
  expect(currentOf([], "x")).toBe("");
});

test("his words alone answer; clearing them reopens; an option he tapped stays", () => {
  const open = { answer: null, options: [], status: "open" as const };
  expect(noteAnswer(open, "tomorrow")).toBe("note");
  expect(noteAnswer({ ...open, answer: "note" }, "")).toBeNull();
  expect(noteAnswer({ ...open, answer: "a" }, "")).toBe("a");
});
