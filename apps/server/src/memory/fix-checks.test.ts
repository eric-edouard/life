import { expect, test } from "bun:test";
import { fixesOf } from "./fix-checks";

const budget = (spent: number, projected: number) => ({
  isPassed: spent >= 50,
  monthly: 50,
  projected,
  spent,
});

test("the fix list: a signed-out bridge, and the month's amount only while its pace would pass it and it is not passed yet", () => {
  const signedOut = [{ label: "LINE", name: "line" }];
  expect(fixesOf(signedOut, undefined, "2026-11").map((f) => f.ref)).toEqual([
    "fix:signed-out/line",
  ]);
  expect(fixesOf([], budget(20, 60), "2026-11")).toMatchObject([
    {
      options: ["raise", "keep"],
      question: "Raise this month's amount to $100?",
      ref: "fix:budget/2026-11",
    },
  ]);
  expect(fixesOf([], budget(20, 45), "2026-11")).toEqual([]);
  expect(fixesOf([], budget(55, 80), "2026-11")).toEqual([]);
  expect(fixesOf([], undefined, "2026-11")).toEqual([]);
});
