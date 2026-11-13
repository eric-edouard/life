import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { llmFor } from "../models/llm";
import {
  begin,
  inBatches,
  inputsOf,
  metered,
  recordRun,
  trackProcessingSteps,
} from "./run";
import { runs } from "./run-log";

/** The run as the status reads' `read_processing_runs` reads it back from the (test) log. */
const read = async (step: string, run: string) =>
  (await runs({ steps: [step] })).items.find((r) => r.id === `${step}/${run}`);

test("a run is logged as started, then ended with its duration, under its start instant", async () => {
  const step = "memory.test-ok";
  const rec = recordRun(step, { days: 1 });
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
  const rec = recordRun(step, {});
  rec.error("offline", { unit: "u1" });
  rec.end({ error: "offline", failedAt: "triage", outcome: "failed" });
  expect(await read(step, rec.run)).toMatchObject({
    errors: [{ error: "offline", unit: "u1" }],
    outcome: "failed",
    result: { failedAt: "triage" },
  });
});

test("a processing run fails at the processing step whose step failed anything, its errors and sub-steps' under its run", async () => {
  const step = "memory.backfill";
  const rec = recordRun(step, {});
  const steps = trackProcessingSteps(rec);
  await steps.step("triage", async () => ({ failed: 0 }));
  rec.error("offline", { step: `${step}.push` });
  const failure = await steps
    .step("extract", async () => ({ failed: 2 }))
    .catch(steps.failed);
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

test("a step uses its explicit engine without changing the ordinary engine", async () => {
  const step = await begin("test-engine", "fast", {}, "codex");
  expect(step.llm.engine).toBe("codex");
  expect(step.end({}).model).toContain("codex/");
});

test("a metered run reads only its explicit engine quota at start and end", async () => {
  const models = await import("../models/llm");
  const quota = spyOn(models, "quota").mockResolvedValue(undefined);
  try {
    const rec = await metered("memory.test-metered", {}, "codex");
    await rec.end({ outcome: "ok" });
    expect(quota.mock.calls).toEqual([["codex"], ["codex"]]);
  } finally {
    quota.mockRestore();
  }
});

test("a processing run's selected engine reaches collection, attachments, episodes and extraction", async () => {
  const sources = await import("./sources");
  const files = await import("./message-files");
  const steps = await import("./run");
  const { gather } = await import("./units");
  const { episodes } = await import("./episodes");
  const { extract } = await import("./extract");
  const { readPeople } = await import("./who");
  const ready = spyOn(sources, "readySources").mockReturnValue([]);
  const described = spyOn(files, "describeFiles").mockResolvedValue({
    calls: 0,
    copied: 0,
    described: 0,
    failed: 0,
    missing: [],
    model: "codex/test",
    ms: 0,
    read: 0,
    run: "test",
  });
  const stopped = new Error("engine inspected before model work");
  const started = spyOn(steps, "begin").mockRejectedValue(stopped);
  try {
    const evidence = await gather(
      { from: "2025-03-01", to: "2025-03-01" },
      await readPeople(),
      { engine: "codex" }
    );
    expect(described.mock.calls.at(0)?.[1]).toBe("codex");
    expect(evidence.engine).toBe("codex");
    await expect(episodes(evidence)).rejects.toThrow(stopped);
    await expect(extract(evidence)).rejects.toThrow(stopped);
    expect(started.mock.calls.map((args) => [args[0], args[3]])).toEqual([
      ["episodes", "codex"],
      ["extract", "codex"],
    ]);
  } finally {
    started.mockRestore();
    described.mockRestore();
    ready.mockRestore();
  }
});

test("a call's inputs digest is pinned: the one personas, situations and appointments kept (a change rebuilds them all)", () => {
  expect(inputsOf("memory-persona.v2", { a: 1 })).toBe("dba367e9d7038416");
  expect(inputsOf("p", { a: 1 })).not.toBe(inputsOf("q", { a: 1 }));
});

test("batches run as many at once as their engine takes, the next starting as one ends; a throw starts no new one", async () => {
  const most = async (engine: "codex" | "openrouter", n: number) => {
    const dir = mkdtempSync(join(tmpdir(), "batches-"));
    let [now, top] = [0, 0];
    const ran: number[] = [];
    await inBatches(
      Array.from({ length: n }, (_, i) => i),
      { dir, llm: llmFor("main", engine) },
      async (i) => {
        now += 1;
        top = Math.max(top, now);
        await Bun.sleep(1);
        ran.push(i);
        now -= 1;
      }
    );
    expect(ran.toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: n }, (_, i) => i)
    );
    expect(readdirSync(dir).length).toBe(n);
    return top;
  };
  expect(await most("openrouter", 100)).toBe(32);
  expect(await most("codex", 100)).toBe(4);
  expect(await most("openrouter", 3)).toBe(3);

  const started: number[] = [];
  const failing = inBatches(
    Array.from({ length: 20 }, (_, i) => i),
    {
      dir: mkdtempSync(join(tmpdir(), "batches-")),
      llm: llmFor("main", "codex"),
    },
    async (i) => {
      started.push(i);
      await Bun.sleep(1);
      throw new Error("refused");
    }
  );
  await expect(failing).rejects.toThrow("refused");
  expect(started.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3]);
});
