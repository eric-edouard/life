import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { applyLine, decisionsNow, writeDecision } from "./decisions";
import { DECISIONS } from "./ledger";

const NOW = Date.parse("2026-10-29T10:00:00.000Z");
const ask = {
  deadline: "2026-11-05T10:00:00.000Z",
  loop: "fact-checks",
  options: [
    { id: "true", label: "Right" },
    { id: "false", label: "Wrong" },
  ],
  question: "Zoé runs the bakery.",
  ref: "obs_000000000001",
};
const id = "fact-checks-20261029100000-1";
const fresh = () => rmSync(DECISIONS, { force: true });

test("a decision goes open, answered, done; each step only from the state before it", () => {
  fresh();
  try {
    writeDecision([{ data: ask, decision: id, step: "asked" }], NOW);
    expect(() =>
      writeDecision([{ data: ask, decision: id, step: "asked" }], NOW)
    ).toThrow("exists");
    expect(() =>
      writeDecision(
        [{ data: { result: "x" }, decision: id, step: "done" }],
        NOW
      )
    ).toThrow("is open");
    expect(() =>
      writeDecision(
        [{ data: { answer: "maybe" }, decision: id, step: "answered" }],
        NOW
      )
    ).toThrow("one of its options");
    writeDecision(
      [
        {
          data: { answer: "false", note: "she sold it" },
          decision: id,
          step: "answered",
        },
      ],
      NOW
    );
    expect(() => writeDecision([{ decision: id, step: "done" }], NOW)).toThrow(
      "needs result"
    );
    writeDecision(
      [{ data: { result: "Recorded in Life" }, decision: id, step: "done" }],
      NOW
    );
    expect(decisionsNow().get(id)).toMatchObject({
      answer: "false",
      note: "she sold it",
      result: "Recorded in Life",
      status: "done",
    });
  } finally {
    fresh();
  }
});

test("an open one expires only past its deadline", () => {
  fresh();
  try {
    writeDecision([{ data: ask, decision: id, step: "asked" }], NOW);
    const expire = (at: number) =>
      writeDecision(
        [{ data: { result: "Skipped" }, decision: id, step: "expired" }],
        at
      );
    expect(() => expire(NOW)).toThrow("not past its deadline");
    expire(Date.parse(ask.deadline));
    expect(decisionsNow().get(id)?.status).toBe("expired");
  } finally {
    fresh();
  }
});

test("an old line still folds: a loop's decision to nothing, a fact check's taken step to no change, an answer whatever its length", () => {
  const at = "2026-10-29T10:00:00.000Z";
  const line = (
    decision: string,
    step: "asked" | "answered" | "taken" | "done",
    data: Record<string, unknown>
  ) => ({
    at,
    data,
    decision,
    schemaVersion: 1 as const,
    step,
  });
  const loop = "asks-20261029100000-1";
  const fold = (lines: ReturnType<typeof line>[]) => {
    const all = new Map();
    for (const l of lines) {
      applyLine(all, l);
    }
    return all;
  };
  const all = fold([
    line(loop, "asked", { ...ask, loop: "asks" }),
    line(loop, "answered", { answer: "true" }),
    line(id, "asked", ask),
    line(id, "answered", { answer: "note", note: "x".repeat(5000) }),
    line(id, "taken", {}),
  ]);
  expect(all.has(loop)).toBe(false);
  expect(all.get(id)).toMatchObject({ answer: "note", status: "answered" });
  // An answer line with no note at all, as nothing writes now but a line once might have.
  const bare = fold([
    line(id, "asked", ask),
    line(id, "answered", { answer: "true" }),
    line(id, "done", { result: "Recorded in Life" }),
  ]);
  expect(bare.get(id)).toMatchObject({
    answer: "true",
    note: "",
    status: "done",
  });
});
