import { expect, test } from "bun:test";
import { phases, record } from "./run";
import { runs } from "./run-log";

/** The run as the dashboard's `runs` reads it back from the (test) log. */
const read = async (step: string, run: string) =>
  (await runs({ steps: [step] })).items.find((r) => r.id === `${step}/${run}`);

test("a run is logged as started, then ended with its duration, under its start instant", async () => {
  const step = "memory.test-ok";
  const rec = record(step, { days: 1 });
  const summary = rec.end({ calls: 2, outcome: "ok" });
  expect(summary).toEqual({
    calls: 2,
    ms: expect.any(Number),
    outcome: "ok",
    run: rec.run,
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
  rec.end({ error: "offline", failedAt: "triage", outcome: "failed" });
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
  rec.end(failure);
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
