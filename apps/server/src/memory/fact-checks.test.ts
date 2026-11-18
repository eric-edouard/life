import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { appendJsonl } from "../core/files";
import { FactCheck } from "../records/fact-check";
import { checksNow } from "./checks";
import { recordFactCheckAnswer } from "./fact-checks";
import {
  FACT_CHECK_ANSWERS,
  FACT_CHECKS,
  readFactCheckAnswers,
  readFactChecks,
} from "./memory-files";

test("an old drawn fact check, never answered, is no longer open, and answering it is refused", async () => {
  for (const f of [FACT_CHECK_ANSWERS, FACT_CHECKS]) {
    rmSync(f, { force: true });
  }
  const old = {
    at: "2026-10-01T10:00:00.000Z",
    date: "2026-09-30",
    group: "episodes" as const,
    kind: "fact" as const,
    ref: "obs_000000000001",
    schemaVersion: 1 as const,
    source: "whatsapp" as const,
    text: "Zoé runs the bakery.",
    units: ["unit_000000000000"],
  };
  appendJsonl(FACT_CHECKS, FactCheck, [old]);
  expect((await checksNow()).some((c) => c.ref === old.ref)).toBe(false);
  await expect(recordFactCheckAnswer(old.ref, "outdated")).rejects.toThrow(
    "no open ending check"
  );
  expect(readFactChecks()).toEqual([old]);
  expect(readFactCheckAnswers().get(old.ref)).toBeUndefined();
  rmSync(FACT_CHECKS, { force: true });
  rmSync(FACT_CHECK_ANSWERS, { force: true });
});
