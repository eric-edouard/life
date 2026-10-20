import { expect, test } from "bun:test";
import { table } from "./bench";

const counts = (held: number) => ({
  contradicted: 1,
  held,
  missed: 0,
  outdated: 0,
  restated: 1,
  trues: 21,
  ungraded: 0,
});
const row = (label: string, model: string, held?: number) => ({
  label,
  llm: model,
  model,
  ...(held === undefined
    ? { error: "exited 1" }
    : {
        calls: 46,
        claims: 700,
        cost: "subscription",
        failed: 0,
        held: counts(held),
        minutes: 40,
        stated: counts(90),
      }),
});
const about = { facts: 38, judge: "codex/x/medium", rated: 99 };

test("bench table: within the baseline's spread (or 3) is a tie; no baseline is said so", () => {
  const t = table(
    [
      row("life1", "life", 14),
      row("life2", "life", 16),
      row("opus1", "opus", 17),
      row("mimo1", "mimo", 9),
    ],
    about
  );
  expect(t).toContain("| life1 | life | 14/21 | 2 | baseline |");
  expect(t).toContain("| opus1 | opus | 17/21 | 2 | tie |");
  expect(t).toContain("| mimo1 | mimo | 9/21 | 2 | -6.0 |");
  expect(t).toContain("wrong (of 38)");
  const alone = table([row("life1", "life"), row("opus1", "opus", 17)], about);
  expect(alone).toContain("no baseline");
  expect(alone).toContain("| life1 | life | failed: exited 1 |");
});
