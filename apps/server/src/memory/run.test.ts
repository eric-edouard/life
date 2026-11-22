import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_DATA_DIR } from "../core/paths";
import { llmFor } from "../models/llm";
import type { ReadCounts } from "../models/model-call";
import type { SourceEvent } from "../records/source";
import {
  begin,
  inBatches,
  inputsOf,
  isDue,
  metered,
  readsOf,
  recordRun,
  trackProcessingSteps,
} from "./run";
import { runs } from "./run-log";
import { dayUnitId } from "./unit-ids";

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
    // A run's read shows an error by its type; its words stay in the log on the Mac.
    errors: [{ errorType: "Error", unit: "u1" }],
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
    errorType: "Error",
    failedAt: "extract",
    outcome: "failed",
  });
  expect(await read(step, rec.run)).toMatchObject({
    errors: [
      { errorType: "Error", step: `${step}.push` },
      { errorType: "Error", failedAt: "extract" },
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
  const { gather } = await import("./gather");
  const { episodes } = await import("./episodes");
  const { extract } = await import("./extract");
  const { readPeople } = await import("./who");
  const ready = spyOn(sources, "readySources").mockReturnValue([]);
  const described = spyOn(files, "describeFiles").mockResolvedValue({
    calls: 0,
    copied: 0,
    described: 0,
    failed: 0,
    failedRefs: [],
    missing: [],
    model: "codex/test",
    ms: 0,
    read: 0,
    run: "test",
    waiting: 0,
  });
  const stopped = new Error("engine inspected before model work");
  const started = spyOn(steps, "begin").mockRejectedValue(stopped);
  try {
    const evidence = await gather(
      { from: "2025-03-01", to: "2025-03-01" },
      await readPeople(),
      { engine: "codex" }
    );
    expect(described.mock.calls.at(0)?.[1]).toEqual({ engine: "codex" });
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
  // Each call holds until as many run as the engine should take (or every one has started), so the count never
  // depends on how fast the machine is; a cap too low shows as a lower top once the 2 s fallback lets them go.
  const most = async (
    engine: "codex" | "openrouter",
    n: number,
    cap: number
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "batches-"));
    let [now, top, begun] = [0, 0, 0];
    const ran: number[] = [];
    const { promise, resolve: release } = Promise.withResolvers<void>();
    const full = Promise.race([promise, Bun.sleep(2000)]);
    await inBatches(
      Array.from({ length: n }, (_, i) => i),
      { dir, llm: llmFor("main", engine) },
      async (i) => {
        now += 1;
        begun += 1;
        top = Math.max(top, now);
        if (now >= Math.min(cap, n) || begun === n) {
          release();
        }
        await full;
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
  expect(await most("openrouter", 100, 32)).toBe(32);
  expect(await most("codex", 100, 4)).toBe(4);
  expect(await most("openrouter", 3, 32)).toBe(3);

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

test("a file is rebuilt when there is none, or `after` old with new inputs", () => {
  const now = new Date("2026-11-08T00:00:00.000Z");
  const week = 7 * 24 * 3_600_000;
  const last = { built: "2026-11-05T00:00:00.000Z", inputs: "a" };
  expect(isDue(null, "a", now, week)).toBe(true);
  expect(isDue(last, "b", now, week)).toBe(false);
  const old = { ...last, built: "2026-11-01T00:00:00.000Z" };
  expect(isDue(old, "b", now, week)).toBe(true);
  expect(isDue(old, "a", now, week)).toBe(false);
});

test("his words on what Life may keep reach a call's context only for a prompt with the sentence, and name its output", async () => {
  const models = await import("../models/llm");
  const asked = spyOn(models, "askOnce").mockResolvedValue({});
  const me = join(OWNER_DATA_DIR, "truth", "me.md");
  const was = readFileSync(me, "utf8");
  try {
    const plain = await begin("test-may-keep", "fast", {});
    await plain.ask({
      dir: plain.dir,
      input: {},
      prompt: "memory-extract.v8",
      reads: readsOf([{ source: "memory", unit: "x" }]),
    });
    expect(asked.mock.calls.at(-1)?.[0].context).toBeUndefined();
    expect(plain.madeBy("memory-extract.v8").prompt).not.toContain("mayKeep");

    writeFileSync(
      me,
      `${was}\n## What Life may keep\nNothing about my health.\n`
    );
    const step = await begin("test-may-keep", "fast", {});
    await step.ask({
      context: { areas: [] },
      dir: step.dir,
      input: {},
      prompt: "memory-extract.v8",
      reads: readsOf([{ source: "memory", unit: "x" }]),
    });
    expect(asked.mock.calls.at(-1)?.[0].context).toEqual({
      areas: [],
      mayKeep: "Nothing about my health.",
    });
    expect(step.madeBy("memory-extract.v8").prompt).toContain("-with-mayKeep");
    // A prompt without the sentence is called as it was.
    await step.ask({
      dir: step.dir,
      input: {},
      prompt: "memory-closeness.v1",
      reads: readsOf([{ source: "memory", unit: "x" }]),
    });
    expect(asked.mock.calls.at(-1)?.[0].context).toBeUndefined();
    expect(step.madeBy("memory-closeness.v1").prompt).toBe(
      "memory-closeness.v1"
    );
  } finally {
    writeFileSync(me, was);
    asked.mockRestore();
  }
});

test("a call's reads count distinct units per source: a chat-day's messages are one unit, two days are two", () => {
  const message = (at: string) =>
    ({ at, chat: "chat-1", source: "whatsapp" }) as SourceEvent;
  const day = ["12:00", "12:05", "12:10"].map((t) =>
    message(`2026-11-10T${t}:00.000Z`)
  );
  const unitOf = (e: SourceEvent) => ({ source: e.source, unit: dayUnitId(e) });
  // Its counts as plain numbers: only readsOf makes a CallReads.
  const counted = (r: ReadCounts) => ({ ...r });
  expect(counted(readsOf(day.map(unitOf)))).toEqual({ whatsapp: 1 });
  expect(
    counted(readsOf([...day, message("2026-11-11T12:00:00.000Z")].map(unitOf)))
  ).toEqual({ whatsapp: 2 });
  expect(
    counted(readsOf([...day.map(unitOf), { source: "memory", unit: "fact-1" }]))
  ).toEqual({ memory: 1, whatsapp: 1 });
});
