import { afterAll, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { daysBefore } from "../core/clock";
import { LOG_DIR } from "../core/log";
import { dayStart } from "../memory/zones";
import { apifySpendsOf, readSpendingDay, writeSpendingDays } from "./spending";

// Model spending's day files on made-up log days long past (the test state's own log folder).

const DAYS = ["2020-01-02", "2020-01-03", "2020-01-04"];
// Fourteen made-up days for the closure and the cap.
const MARCH = Array.from({ length: 14 }, (_, i) => daysBefore("2020-03-15", i));
const line = (at: string, more: Record<string, unknown>) =>
  JSON.stringify({
    engine: "openrouter",
    kind: "model.run",
    run: "r",
    time: at,
    ...more,
  });
mkdirSync(LOG_DIR, { recursive: true });
afterAll(() => {
  setSystemTime();
  for (const d of [...DAYS, ...MARCH]) {
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
      line("2020-01-03T12:15:00.000Z", {
        engine: "claude",
        model: "sonnet",
        tokens: { cached: 0, input: 1000, output: 0 },
      }),
      JSON.stringify({
        count: 2,
        kind: "model.local",
        model: "describer",
        ms: 50,
        time: "2020-01-03T12:30:00.000Z",
      }),
      "",
    ].join("\n")
  );
  writeFileSync(join(LOG_DIR, "2020-01-02.jsonl"), "");
  writeFileSync(join(LOG_DIR, "2020-01-04.jsonl"), "");
  const none = { jobs: [], modelRuns: [], unsettled: 0, voiceNotes: [] };
  const unsettled = { ...none, unsettled: 1 };
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

test("a day is read only once its next local midnight has passed, whatever today says; at most 7 days a night, a leftover sibling of an interrupted write never counts as written", async () => {
  for (const d of MARCH) {
    writeFileSync(join(LOG_DIR, `${d}.jsonl`), "");
  }
  const none = () =>
    Promise.resolve({ jobs: [], modelRuns: [], unsettled: 0, voiceNotes: [] });
  // An interrupted write left only its sibling.
  writeFileSync(
    `${join(LOG_DIR, "..", "spending", "2020-03-14.json")}.1.tmp`,
    "{"
  );
  // Today is the 15th where he is now, but the 14th's own local day has a minute left.
  setSystemTime(new Date(dayStart("2020-03-15").getTime() - 60_000));
  const first = await writeSpendingDays("2020-03-15", none);
  expect(first).not.toContain("2020-03-14");
  expect(first).toHaveLength(7);
  setSystemTime(new Date(dayStart("2020-03-15").getTime() + 60_000));
  const second = await writeSpendingDays("2020-03-15", none);
  expect(second[0]).toBe("2020-03-14");
  expect(second.filter((d) => first.includes(d))).toEqual([]);
  expect(readSpendingDay("2020-03-14")?.unsettled).toBe(0);
});

test("an Apify run counts once its bill is whole; one running or just ended keeps its day unsettled", () => {
  const now = new Date("2026-11-20T10:00:00Z");
  const run = (finishedAt: string | null, usd: number | null) => ({
    at: "2026-11-19T09:00:00Z",
    finishedAt,
    usd,
  });
  const { spends, unsettled } = apifySpendsOf(
    [
      run("2026-11-19T09:01:00Z", 0.0026),
      run(null, 0.000_05),
      run("2026-11-20T09:59:30Z", 0.000_05),
    ],
    now
  );
  expect(spends).toEqual([
    expect.objectContaining({ provider: "apify", reported: true, usd: 0.0026 }),
  ]);
  expect(unsettled).toBe(2);
});
