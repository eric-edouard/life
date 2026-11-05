import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIFE_CODE_DIR } from "@life/server/src/core/paths";
import { git } from "@life/server/src/core/proc";
import { checkout, factTable } from "./bench";

const counts = (held: number) => ({
  both: 1,
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
        timeline: {
          duplicates: 1,
          end: { checked: 8, ok: 5 },
          extra: 3,
          found: 10,
          merged: 2,
          missed: 4,
          place: { checked: 9, ok: 8 },
          start: { checked: 10, ok: 7 },
          truth: 16,
        },
      }),
});
const about = { days: ["2026-10-20"], facts: 38, rated: 99 };

test("bench table: within the baseline's spread (or 3) is a tie; no baseline is said so", () => {
  const t = factTable(
    [
      row("life1", "life", 14),
      row("life2", "life", 16),
      row("opus1", "opus", 17),
      row("mimo1", "mimo", 9),
    ],
    about
  );
  expect(t).toContain("| life1 | life | 14/21 | 2 | 1 | baseline |");
  expect(t).toContain("| opus1 | opus | 17/21 | 2 | 1 | tie |");
  expect(t).toContain("| mimo1 | mimo | 9/21 | 2 | 1 | -6.0 |");
  expect(t).toContain("90/21, 2 wrong, 1 kept both");
  expect(t).toContain("wrong (of 38)");
  expect(t).toContain(
    "10/16, 2 merged, 3 extra, 1 dup, start 7/10, end 5/8, place 8/9"
  );
  const alone = factTable(
    [row("life1", "life"), row("opus1", "opus", 17)],
    about
  );
  expect(alone).toContain("no baseline");
  expect(alone).toContain("| life1 | life | failed: exited 1 |");
});

test("a bench worktree runs its own code: its workspace packages resolve inside it, never to the main checkout", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "life-checkout-"));
  const dir = join(tmp, "code");
  try {
    await checkout(dir, []);
    expect(realpathSync(join(dir, "node_modules/@life/server"))).toBe(
      join(realpathSync(dir), "apps/server")
    );
  } finally {
    git(LIFE_CODE_DIR, ["worktree", "remove", "--force", dir]);
    rmSync(tmp, { force: true, recursive: true });
  }
}, 60_000);
