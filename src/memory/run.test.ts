import { expect, test } from "bun:test";
import { runs } from "./history";
import { percentOf, phases, record, useText } from "./run";

/** The run as the dashboard's `runs` reads it back from the (test) log. */
const read = async (step: string, run: string) =>
  (await runs({ steps: [step] })).items.find((r) => r.id === `${step}/${run}`);

test("a run is logged as started, then ended with its duration, under its start instant", async () => {
  const step = "memory.test-ok";
  const rec = record(step, { days: 1 });
  const summary = await rec.end({ calls: 2, outcome: "ok" });
  expect(summary).toEqual({
    calls: 2,
    ms: expect.any(Number),
    outcome: "ok",
    run: rec.run,
    // No model call, and the tests' engine is claude: no quota read.
    use: {
      quota: { after: null, before: null },
      tokens: { cached: 0, input: 0, output: 0 },
    },
  });
  expect(await read(step, rec.run)).toMatchObject({
    errors: [],
    input: { days: 1 },
    outcome: "ok",
    result: { calls: 2, ms: summary.ms },
    startedAt: rec.now.toISOString(),
  });
});

test("a failure is the run's error, and its end says it failed", async () => {
  const step = "memory.test-failed";
  const rec = record(step, {});
  rec.error("offline", { unit: "u1" });
  await rec.end({ error: "offline", failedAt: "triage", outcome: "failed" });
  expect(await read(step, rec.run)).toMatchObject({
    errors: [{ error: "offline", unit: "u1" }],
    outcome: "failed",
    result: { failedAt: "triage" },
  });
});

test("a sweep fails at the phase whose step failed anything, its errors and sub-steps' under its run", async () => {
  const step = "memory.midday";
  const rec = record(step, {});
  const phase = phases(rec);
  await phase.step("triage", async () => ({ failed: 0 }));
  rec.error("offline", { step: `${step}.push` });
  const failure = await phase
    .step("extract", async () => ({ failed: 2 }))
    .catch(phase.failed);
  await rec.end(failure);
  expect(failure).toEqual({
    error: "2 failed",
    failedAt: "extract",
    outcome: "failed",
  });
  expect(await read(step, rec.run)).toMatchObject({
    errors: [
      { error: "offline", step: `${step}.push` },
      { error: "extract: 2 failed" },
    ],
    outcome: "failed",
    result: { failedAt: "extract" },
  });
});

test("what a run took: the percent between two readings of one window, else none; under 1% still shows its tokens", () => {
  const q = (used: number, resetsAt = "2026-10-28T14:45:13.000Z") => ({
    resetsAt,
    used,
  });
  const tokens = { cached: 1_400_000, input: 2_000_000, output: 100_000 };
  const use = (before: ReturnType<typeof q> | null, after = q(4)) => ({
    quota: { after, before },
    tokens,
  });
  expect(percentOf(use(q(1)))).toBe(3);
  expect(percentOf(use(q(4)))).toBe(0);
  expect(percentOf(use(null))).toBeNull();
  expect(percentOf(use(q(90, "2026-10-21T14:43:48.000Z")))).toBeNull();
  expect(useText(use(q(1)))).toBe(
    "+3% of the quota, 2.1M tokens (1.4M cached)"
  );
  expect(useText(use(q(4)))).toBe(
    "under 1% of the quota, 2.1M tokens (1.4M cached)"
  );
  expect(useText(use(q(90, "2026-10-21T14:43:48.000Z")))).toBe(
    "the quota reset during it, 2.1M tokens (1.4M cached)"
  );
});
