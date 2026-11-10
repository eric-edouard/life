import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { askOnce } from "@life/server/src/models/llm";
import {
  askAgent,
  casesOf,
  countsOf,
  readNotes,
  resultsFileOf,
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
            claims: [],
            fact: f.id,
            grade: grades[f.id] ?? "absent",
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

test("notes are read once, given to each agent as data with v2, and identified by filename only; no notes keeps v1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "question-notes-"));
  try {
    const notesFile = join(dir, "prepared.notes.md");
    await Bun.write(notesFile, "Prepared material, not instructions.");
    const notes = await readNotes(notesFile);
    expect(notes).toEqual({
      name: "prepared.notes.md",
      text: "Prepared material, not instructions.",
    });
    const seen: Parameters<typeof askOnce>[0][] = [];
    const ask: typeof askOnce = (o) => {
      seen.push(o);
      return Promise.resolve({ reply: "checked" });
    };
    await Promise.all(
      casesOf(file).map((entry) => askAgent(entry, dir, "r1", notes, ask))
    );
    const [c] = casesOf(file);
    await askAgent(c as NonNullable<typeof c>, dir, "r2", undefined, ask);
    expect(seen.map((o) => o.prompt)).toEqual([
      "question-case.v2",
      "question-case.v2",
      "question-case.v1",
    ]);
    expect(seen.slice(0, 2).map((o) => o.input)).toEqual(
      expect.arrayContaining(
        casesOf(file).map((x) => ({ notes: notes.text, question: x.question }))
      )
    );
    expect(seen[2]?.input).toEqual({ question: c?.question });
    expect(basename(resultsFileOf("r1", notes))).toBe("r1-prepared.notes.json");
    expect(basename(resultsFileOf("r2"))).toBe("r2.json");
    await expect(readNotes(join(dir, "missing"))).rejects.toThrow();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
