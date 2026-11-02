import { expect, test } from "bun:test";
import type { Decision } from "@life/server/src/records/decision";
import {
  currentOf,
  DONE,
  moveOf,
  nextOpen,
  noteAnswer,
  orderOf,
} from "./order";

const d = (id: string, extra: Partial<Decision> = {}): Decision => ({
  createdAt: "2026-10-28T10:00:00.000Z",
  id,
  loop: "fact-checks",
  options: [{ id: "a", label: "A" }],
  question: id,
  status: "open",
  ...extra,
});

test("his decisions page: live ones by deadline, closed ones apart; answering moves to the next one still his", () => {
  const { live, past } = orderOf([
    d("x2", { deadline: "2026-11-02T00:00:00.000Z" }),
    d("x1", { deadline: "2026-11-01T00:00:00.000Z" }),
    d("old", { closedAt: "2026-10-29T00:00:00.000Z", status: "done" }),
    d("a1", { answer: "a", status: "answered" }),
  ]);
  expect(live.map((l) => l.id)).toEqual(["x1", "x2", "a1"]);
  expect(past.map((l) => l.id)).toEqual(["old"]);
  expect(nextOpen(live, "x1")?.id).toBe("x2");
  expect(nextOpen(live, "a1")?.id).toBe("x1"); // wraps round
  expect(nextOpen(live, "x2")?.id).toBe("x1"); // skips what he answered
  expect(nextOpen([d("a1", { answer: "a" })], "a1")).toBeUndefined();
});

test("only the arrows move, never while he types, and no key is taken from him (30 Oct: every key was cancelled, typing did nothing)", () => {
  expect(moveOf("ArrowRight", null)).toBe(1);
  expect(moveOf("ArrowLeft", null)).toBe(-1);
  expect(moveOf("a", null)).toBe(0);
  expect(moveOf("Escape", null)).toBe(0);
});

test("the decision on screen: the link's while it is live, the end only once nothing is open, else the first open one", () => {
  const open = d("o1");
  const answered = d("a1", { answer: "a", status: "answered" });
  expect(currentOf([answered, open], "a1")).toBe("a1");
  expect(currentOf([answered, open], "closed-one")).toBe("o1");
  expect(currentOf([answered, open], DONE)).toBe("o1"); // a new one came in
  expect(currentOf([answered], DONE)).toBe(DONE);
  expect(currentOf([], "x")).toBe("");
});

test("his words alone answer; clearing them reopens; an option he tapped stays", () => {
  const open = { answer: null, status: "open" as const };
  expect(noteAnswer(open, "tomorrow")).toBe("note");
  expect(noteAnswer({ ...open, answer: "note" }, "")).toBeNull();
  expect(noteAnswer({ ...open, answer: "a" }, "")).toBe("a");
});
