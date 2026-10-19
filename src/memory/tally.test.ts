import { expect, test } from "bun:test";
import { GRADES, tally } from "./tally";

test("every grade of a true and of a false fact: held, contradicted, restated, missed; a fact the judge left out is ungraded; an outdated one is a true one held, counted apart", () => {
  const facts = GRADES.flatMap((g) => [
    { id: `t-${g}`, true: true },
    { id: `f-${g}`, true: false },
  ]);
  const graded = GRADES.flatMap((grade) => [
    { fact: `t-${grade}`, grade },
    { fact: `f-${grade}`, grade },
  ]);
  const t = tally(
    [
      ...facts,
      { id: "t-left-out", true: true },
      { id: "t-outdated", outdated: true, true: true },
    ],
    graded
  );
  expect(Object.fromEntries(t.marks)).toEqual({
    "f-absent": "ok",
    "f-both": "WRONG",
    "f-contradicted": "ok",
    "f-stated": "WRONG",
    "t-absent": "miss",
    "t-both": "WRONG",
    "t-contradicted": "WRONG",
    "t-left-out": "ungraded",
    "t-outdated": "ok",
    "t-stated": "ok",
  });
  expect(t.counts).toEqual({
    contradicted: 2,
    held: 2,
    missed: 1,
    outdated: 1,
    restated: 2,
    trues: 6,
    ungraded: 1,
  });
});
