import { expect, test } from "bun:test";
import { GRADES, tally } from "./tally";

test("every grade of a true and of a false fact: held, contradicted, restated, missed; a fact the judge left out is ungraded", () => {
  const facts = GRADES.flatMap((g) => [
    { id: `t-${g}`, true: true },
    { id: `f-${g}`, true: false },
  ]);
  const graded = GRADES.flatMap((grade) => [
    { fact: `t-${grade}`, grade },
    { fact: `f-${grade}`, grade },
  ]);
  const t = tally([...facts, { id: "t-left-out", true: true }], graded);
  expect(Object.fromEntries(t.marks)).toEqual({
    "f-absent": "ok",
    "f-both": "WRONG",
    "f-contradicted": "ok",
    "f-stated": "WRONG",
    "t-absent": "miss",
    "t-both": "WRONG",
    "t-contradicted": "WRONG",
    "t-left-out": "ungraded",
    "t-stated": "ok",
  });
  expect(t.counts).toEqual({
    contradicted: 2,
    held: 1,
    missed: 1,
    restated: 2,
    trues: 5,
    ungraded: 1,
  });
});
