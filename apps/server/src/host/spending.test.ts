import { afterAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOG_DIR } from "../core/log";
import { readSpendingDay, writeSpendingDays } from "./spending";

// Model spending's day files on made-up log days long past (the test state's own log folder).

const DAYS = ["2020-01-02", "2020-01-03", "2020-01-04"];
const line = (at: string, more: Record<string, unknown>) =>
  JSON.stringify({
    engine: "openrouter",
    kind: "model.run",
    run: "r",
    time: at,
    ...more,
  });
afterAll(() => {
  for (const d of DAYS) {
    rmSync(join(LOG_DIR, `${d}.jsonl`), { force: true });
  }
});

test("the night writes each closed day once from its records, billed and equivalent apart; a day with Voice jobs unsettled waits, then is written with their count; a failed read is tried again, never zero", async () => {
  writeFileSync(
    join(LOG_DIR, "2020-01-03.jsonl"),
    [
      line("2020-01-03T12:00:00.000Z", {
        spentByRouter: {
          openrouter: {
            costUsd: 0.25,
            isPriced: true,
            tokens: { cached: 0, input: 900, output: 100 },
          },
        },
      }),
      line("2020-01-03T13:00:00.000Z", {
        engine: "claude",
        model: "sonnet",
        tokens: { cached: 0, input: 1000, output: 0 },
      }),
      JSON.stringify({
        count: 2,
        kind: "model.local",
        model: "describer",
        ms: 50,
        time: "2020-01-03T14:00:00.000Z",
      }),
    ].join("\n")
  );
  writeFileSync(join(LOG_DIR, "2020-01-02.jsonl"), "");
  writeFileSync(join(LOG_DIR, "2020-01-04.jsonl"), "");
  const none = { jobs: [], modelRuns: [], voiceNotes: [] };
  const unsettled = {
    ...none,
    jobs: [
      {
        at: "2020-01-04T10:00:00.000Z",
        billableSeconds: 60,
        outcome: "unsettled" as const,
        seconds: 60,
        transcriber: "scribe" as const,
      },
    ],
  };
  let isDown = true;
  const voice = (from: string) =>
    from.startsWith("2020-01-02") && isDown
      ? Promise.reject(new Error("down"))
      : Promise.resolve(from.startsWith("2020-01-04") ? unsettled : none);
  expect(await writeSpendingDays("2020-01-05", voice)).toEqual(["2020-01-03"]);
  expect(readSpendingDay("2020-01-03")).toMatchObject({
    byKind: [{ billedUsd: 0.25, kind: "daytime", tokens: 2000 }],
    unsettled: 0,
  });
  const providers = readSpendingDay("2020-01-03")?.byProvider ?? [];
  expect(
    providers.map((p) => [
      p.provider,
      p.basis,
      p.billedUsd,
      p.calls,
      p.reported,
    ])
  ).toEqual([
    ["openrouter", "billed", 0.25, 1, true],
    ["claude", "equivalent", 0, 1, false],
    ["describer", "billed", 0, 2, true],
  ]);
  isDown = false;
  // A week on, the unsettled day is written with its count; the failed day is read again.
  expect(await writeSpendingDays("2020-01-12", voice)).toEqual([
    "2020-01-04",
    "2020-01-02",
  ]);
  expect(readSpendingDay("2020-01-04")?.unsettled).toBe(1);
  expect(await writeSpendingDays("2020-01-12", voice)).toEqual([]);
});
