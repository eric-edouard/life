import { expect, test } from "bun:test";
import { asOf, GRADES, tally } from "./tally";

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
    "f-both": "both",
    "f-contradicted": "ok",
    "f-stated": "WRONG",
    "t-absent": "miss",
    "t-both": "both",
    "t-contradicted": "WRONG",
    "t-left-out": "ungraded",
    "t-outdated": "ok",
    "t-stated": "ok",
  });
  expect(t.counts).toEqual({
    both: 2,
    contradicted: 1,
    held: 2,
    missed: 1,
    outdated: 1,
    restated: 1,
    trues: 6,
    ungraded: 1,
  });
});

test("a fact with a day is judged against the claims said by then: a later change never contradicts it", () => {
  const claims = [
    {
      date: "2026-10-14",
      id: "c14",
      text: "The card is on its way to the branch.",
    },
    {
      date: "2026-10-15",
      id: "c15",
      text: "He collected the card at the branch.",
    },
  ];
  const calls = asOf(
    [
      {
        date: "2026-10-14",
        fact: "He is waiting for the card.",
        id: "waiting",
      },
      { fact: "He has the card.", id: "has" },
    ],
    claims
  );
  expect(
    calls.map((c) => [
      c.date,
      c.facts.map((f) => f.id),
      c.claims.map((x) => x.id),
    ])
  ).toEqual([
    ["2026-10-14", ["waiting"], ["c14"]],
    [undefined, ["has"], ["c14", "c15"]],
  ]);
});
