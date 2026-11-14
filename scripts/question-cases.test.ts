import { expect, test } from "bun:test";
import {
  casesOf,
  countsOf,
  marksAcross,
  readRun,
  runCase,
} from "./question-cases";

const file = {
  about: "made-up cases",
  cases: [
    {
      asker: "owner",
      contain: ["Ana moved to Lyon in March"],
      id: "C1",
      not: { contain: ["Ana moved to Paris"] },
      question: "Where does Ana live now?",
    },
    {
      asker: "mined",
      contain: ["the deposit was paid"],
      id: "B2",
      question: "Did I pay the deposit?",
    },
  ],
};

test("cases are read strictly: a question, at least one point a right reply holds, an id that starts with its kind", () => {
  expect(casesOf(file).map((c) => [c.id, c.not.contain.length])).toEqual([
    ["C1", 1],
    ["B2", 0],
  ]);
  expect(casesOf(file, ["B2"]).map((c) => c.id)).toEqual(["B2"]);
  const [first] = file.cases;
  expect(() =>
    casesOf({ ...file, cases: [{ ...first, contain: [] }] })
  ).toThrow();
  expect(() => casesOf({ ...file, cases: [{ ...first, id: "x1" }] })).toThrow();
});

test("a case passes when the reply states every point it must hold and none it must not; the judge is never told which is which", async () => {
  const [c] = casesOf(file);
  const seen: unknown[] = [];
  const run = (grades: Record<string, "stated" | "absent">) =>
    runCase(c as NonNullable<typeof c>, {
      ask: () => Promise.resolve({ reply: "She lives in Lyon since March." }),
      dir: "/nowhere",
      grade: (facts, claims) => {
        seen.push(facts, claims);
        return Promise.resolve(
          facts.map((f) => ({
            fact: f.id,
            grade: grades[f.id] ?? "absent",
            memoryLines: [],
            why: "",
          }))
        );
      },
      run: "r1",
      today: "2026-11-10",
    });
  const good = await run({ c0: "stated", n0: "absent" });
  expect([good.passed, good.reply]).toEqual([
    true,
    "She lives in Lyon since March.",
  ]);
  expect(good.points.map((p) => [p.id, p.mark])).toEqual([
    ["c0", "ok"],
    ["n0", "ok"],
  ]);
  expect((await run({ c0: "absent", n0: "absent" })).passed).toBe(false);
  expect((await run({ c0: "stated", n0: "stated" })).passed).toBe(false);
  expect(seen[1]).toEqual([
    { date: "2026-11-10", id: "reply", text: "She lives in Lyon since March." },
  ]);
});

test("a reply that is not one is the case's error; the report is counts by kind and asker", async () => {
  const [c] = casesOf(file);
  await expect(
    runCase(c as NonNullable<typeof c>, {
      ask: () => Promise.resolve("no json here"),
      dir: "/nowhere",
      grade: () => Promise.resolve([]),
      run: "r1",
      today: "2026-11-10",
    })
  ).rejects.toThrow();
  expect(
    countsOf([
      { asker: "owner", id: "C1", passed: true },
      { asker: "owner", id: "C2", passed: false },
      { asker: "mined", id: "B2" },
      { asker: "mined", error: "timed out", id: "B3" },
    ])
  ).toEqual([
    { asked: 1, cases: 2, key: "B mined", passed: 0 },
    { asked: 2, cases: 2, key: "C owner", passed: 1 },
  ]);
});

test("the marks across runs: ids and marks only, the must-hold points no baseline run found, a run of two files", () => {
  const row = (id: string, marks: string[]) => ({
    id,
    passed: marks.every((m) => m === "ok"),
    points: marks.map((mark, i) => ({ id: i < 2 ? `c${i}` : "n0", mark })),
  });
  const runs = [
    [row("C1", ["ok", "miss", "ok"])],
    // A baseline asked by two processes: its rows are the two files' together.
    [row("C1", ["miss", "miss", "WRONG"]), row("C2", ["ok", "ok", "ok"])],
    [row("C1", ["ok", "ok", "ok"])],
    [row("C1", ["ok", "ok", "ok"])],
  ];
  expect(marksAcross(runs, 2)).toEqual({
    laterOk: 1,
    never: [{ key: "C1 c1", marks: ["miss", "miss", "ok", "ok"] }],
    runs: [
      { cases: 1, passed: 0, points: 3, pointsOk: 2, wrong: 0 },
      { cases: 2, passed: 1, points: 6, pointsOk: 3, wrong: 1 },
      { cases: 1, passed: 1, points: 3, pointsOk: 3, wrong: 0 },
      { cases: 1, passed: 1, points: 3, pointsOk: 3, wrong: 0 },
    ],
  });
});

test("a run with no result file is an error, never a baseline that found nothing", () => {
  expect(() => readRun("no-such-run+other")).toThrow(
    "no result file no-such-run"
  );
});
