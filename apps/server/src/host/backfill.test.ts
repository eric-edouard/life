import { afterAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { clock, MIN } from "../core/clock";
import { writeJson } from "../core/files";
import { setSettings } from "../core/settings";
import type { Evidence } from "../memory/gather";
import { OUT } from "../memory/memory-files";
import type { Held } from "../sources/contract";
import {
  type BackfillState,
  type BackfillSteps,
  backfill,
  backfillEstimateOf,
  backfillProgressOf,
  backfillWeeks,
  type HeldSource,
  readBackfillState,
  TOKENS_PER_HOUR,
  TOKENS_PER_ITEM,
} from "./backfill";

// Made-up holdings: no disk, no store, only what a source's `held` says it holds.

const held = (count: number, earliest: string | null, noun: string): Held => ({
  count,
  earliest,
  noun,
});

const TODAY = "2025-01-01";

/** Tokens one item of `noun` is estimated at, without a possible `undefined` (the table is indexed by a word). */
const per = (noun: string) => TOKENS_PER_ITEM[noun] ?? 0;

test("items in the range are counted by days from the later of the picked day and the source's first", () => {
  const sources: HeldSource[] = [
    // 366 days of holding, from midday on 1 July: 184 of them are in the range.
    {
      held: held(1000, "2024-01-01T12:00:00.000Z", "messages"),
      name: "imessage",
    },
    // A source whose first item is after the picked day: all of it is in the range.
    { held: held(10, "2024-11-01T12:00:00.000Z", "photos"), name: "photos" },
    // Picked before its first item: the whole of it, and nothing older.
    { held: held(3, "2024-12-01T12:00:00.000Z", "commits"), name: "git" },
  ];
  const estimate = backfillEstimateOf(sources, "2024-07-01", "claude", TODAY);
  expect(estimate.tokens).toBe(
    Math.round((1000 * 184 * per("messages")) / 366) +
      10 * per("photos") +
      3 * per("commits")
  );
  expect(estimate.hours).toBeCloseTo(estimate.tokens / TOKENS_PER_HOUR);
});

test("a picked day before a source's first item counts the whole of it", () => {
  const sources: HeldSource[] = [
    { held: held(100, "2024-01-01T00:00:00.000Z", "messages"), name: "mail" },
  ];
  expect(
    backfillEstimateOf(sources, "2019-01-01", "claude", TODAY).tokens
  ).toBe(100 * per("messages"));
});

test("nothing in range: a picked day after today, a source with no first item, or a source missing", () => {
  const sources: HeldSource[] = [
    { held: held(100, "2024-01-01T00:00:00.000Z", "messages"), name: "mail" },
    { held: held(5, null, "notes"), name: "notes" },
    { held: null, name: "photos" },
  ];
  expect(backfillEstimateOf(sources, "2026-01-01", "claude", TODAY)).toEqual({
    hours: 0,
    tokens: 0,
  });
  expect(
    backfillEstimateOf(
      [{ held: null, name: "photos" }],
      "2024-01-01",
      "claude",
      TODAY
    )
  ).toEqual({ hours: 0, tokens: 0 });
});

test("a billed engine's credits are priced, a subscription has no dollars", () => {
  const sources: HeldSource[] = [
    { held: held(1000, "2024-01-01T00:00:00.000Z", "messages"), name: "mail" },
  ];
  // A day the OpenRouter row prices, the whole of a source first read on its first day.
  const day = "2026-12-01";
  const estimate = backfillEstimateOf(sources, "2024-01-01", "openrouter", day);
  expect(estimate.tokens).toBe(1000 * per("messages"));
  // The OpenRouter row: $0.15 a million input tokens.
  expect(estimate.usd).toBeCloseTo((estimate.tokens * 0.15) / 1e6);
  for (const engine of ["claude", "codex"] as const) {
    expect(
      backfillEstimateOf(sources, "2024-01-01", engine, day).usd
    ).toBeUndefined();
  }
});

test("a noun the table doesn't know is estimated as a message would be", () => {
  const sources: HeldSource[] = [
    { held: held(100, "2024-01-01T00:00:00.000Z", "widgets"), name: "made-up" },
  ];
  expect(
    backfillEstimateOf(sources, "2024-01-01", "claude", TODAY).tokens
  ).toBe(100 * per("messages"));
});

// The job's own tests: made-up weeks and steps, no source read, no model. The test data's first recorded zone is
// Asia/Jakarta, so noon UTC is the same local day there and in Europe.

const NOW = new Date("2024-01-10T05:00:00.000Z");
const DAY = "2024-01-10";
const FROM = "2023-12-06";
/** The weeks of the range, oldest first: what phase B reads in that order. */
const WEEKS = [
  "2023-12-06",
  "2023-12-13",
  "2023-12-20",
  "2023-12-27",
  "2024-01-03",
];
/** What phase A reads: the newest month first. */
const NEWEST_FIRST = [
  "2024-01-03",
  "2023-12-06",
  "2023-12-13",
  "2023-12-20",
  "2023-12-27",
];
const STATE = join(OUT, "backfill.json");
const done = (...weeks: string[]): BackfillState => ({
  from: FROM,
  weeks: Object.fromEntries(weeks.map((w) => [w, 60])),
});
afterAll(() => {
  setSystemTime();
  rmSync(STATE, { force: true });
  setSettings({ backfillFrom: null });
});

/** Made-up steps: nothing read or written, and each week a step was called for is kept, in order. */
function madeUp(over: Partial<BackfillSteps> = {}) {
  const heard: string[] = [];
  const mattered: string[] = [];
  const summarized: string[] = [];
  const steps: BackfillSteps = {
    canStart: () => Promise.resolve(true),
    collect: () => Promise.resolve({ failed: 0 }),
    episodes: () => Promise.resolve({ failed: 0 }),
    evidence: () =>
      Promise.resolve({ failed: [] } as unknown) as Promise<Evidence>,
    extract: () => Promise.resolve({ failed: 0 }),
    hear: (window) => {
      heard.push(window.from);
      return Promise.resolve();
    },
    matters: (window) => {
      mattered.push(window.from);
      return Promise.resolve({ failed: 0 });
    },
    summaries: (from) => {
      summarized.push(from);
      return Promise.resolve();
    },
    zones: () => Promise.resolve({ deferred: [], gaps: [], runs: [] }),
    ...over,
  };
  return { heard, mattered, steps, summarized };
}

test("phase A reads the weeks newest month first, each recorded with its seconds; a resumed turn skips the weeks read", async () => {
  setSettings({ backfillFrom: FROM });
  rmSync(STATE, { force: true });
  const first = madeUp();
  await backfill(NOW, first.steps);
  expect(first.heard).toEqual(NEWEST_FIRST);
  expect(Object.keys(readBackfillState()?.weeks ?? {})).toEqual(NEWEST_FIRST);
  // Three weeks already read: the turn takes the other two, in the same order.
  writeJson(STATE, done("2023-12-13", "2023-12-27", "2024-01-03"));
  const second = madeUp();
  await backfill(NOW, second.steps);
  expect(second.heard).toEqual(["2023-12-06", "2023-12-20"]);
});

test("a turn stops at the reserve or the month's amount, and once its twenty minutes are spent", async () => {
  setSettings({ backfillFrom: FROM });
  rmSync(STATE, { force: true });
  const poor = madeUp({ canStart: async () => false });
  await backfill(NOW, poor.steps);
  expect(poor.heard).toEqual([]);
  // A week that takes 25 of the turn's 20 minutes: the next one waits for the tick.
  const slow = madeUp();
  const { hear } = slow.steps;
  slow.steps.hear = async (window) => {
    await hear(window);
    // The turn's own clock (now, not the date the run reads): 25 minutes spent on one week.
    setSystemTime(new Date(clock().getTime() + 25 * MIN));
  };
  try {
    await backfill(NOW, slow.steps);
  } finally {
    setSystemTime();
  }
  expect(slow.heard).toEqual(["2024-01-03"]);
});

test("phase B places the matters oldest first once every week is read, then writes the summaries once", async () => {
  setSettings({ backfillFrom: FROM });
  writeJson(STATE, done(...WEEKS));
  const phaseB = madeUp();
  await backfill(NOW, phaseB.steps);
  expect(phaseB.heard).toEqual([]);
  expect(phaseB.mattered).toEqual(WEEKS);
  expect(phaseB.summarized).toEqual([FROM]);
  expect(readBackfillState()?.phaseB).toBe("done");
  // Read once: a later turn has nothing left.
  const again = madeUp();
  await backfill(NOW, again.steps);
  expect([again.heard, again.mattered, again.summarized]).toEqual([[], [], []]);
});

test("a failing week logs and stops the turn, and the next turn reads it again", async () => {
  setSettings({ backfillFrom: FROM });
  rmSync(STATE, { force: true });
  const logs = await import("../core/log");
  const logged = spyOn(logs, "log").mockImplementation(
    (() => undefined) as never
  );
  const failing = madeUp({ episodes: async () => ({ failed: 1 }) });
  try {
    await backfill(NOW, failing.steps);
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ step: "backfill" });
  } finally {
    logged.mockRestore();
  }
  expect(failing.heard).toEqual(["2024-01-03"]);
  expect(readBackfillState()?.weeks).toEqual({});
});

test("progress: the mean of the weeks read, the year being read, and the hours left for both phases", () => {
  // A mean of 15 minutes a week: 3 weeks of phase A and all 5 of phase B still to read.
  const quarter = {
    from: FROM,
    weeks: { "2023-12-13": 900, "2024-01-03": 900 },
  };
  expect(backfillProgressOf(quarter, FROM, DAY)).toEqual({
    doneWeeks: 2,
    hoursLeft: 2,
    reading: "2023",
    totalWeeks: 5,
  });
  // A week read before a later pick is not in its range: a changed pick keeps the weeks it holds, nothing more.
  expect(backfillProgressOf(done("2023-01-04"), FROM, DAY).doneWeeks).toBe(0);
  // Phase B done: only phase A's weeks are left.
  expect(
    backfillProgressOf({ ...done("2023-12-13"), phaseB: "done" }, FROM, DAY)
      .hoursLeft
  ).toBe(0.1);
});

test("the range ends before the night's seven days and starts at the picked day", () => {
  expect(backfillWeeks(FROM, DAY).at(-1)?.to).toBe("2024-01-03");
  expect(backfillWeeks(FROM, DAY)).toHaveLength(5);
  expect(backfillWeeks("2024-01-04", DAY)).toEqual([]);
});
