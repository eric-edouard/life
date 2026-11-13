import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { clock } from "../core/clock";
import { digest } from "../core/hash";
import { log } from "../core/log";
import type { Engine } from "../core/names";
import {
  askOnce,
  callsAtOnceOf,
  hasQuota,
  llmFor,
  llmSpec,
  quota,
} from "../models/llm";
import type { Tier } from "../models/model-call";
import { OUT, runId } from "./memory-files";
import { localDate } from "./zones";

// What every memory step shares: the run (its id, folder, counters, failures and end), the batches of model calls.

/**
 * A run of any kind, logged in derived/log as started now with `fields`: its id is its start instant (`runId`). `error`
 * logs a failure of the run (`what.step` names a sub-step: memory.nightly.actions); `end` logs its end with its duration
 * and returns what it logged (`step` aside). No model: the processing runs use it as is, the steps through `begin`.
 */
export function recordStepRun(step: string, fields: Record<string, unknown>) {
  const now = clock();
  const run = runId(now);
  const started = performance.now();
  log("run.start", { ...fields, run, step });
  const ms = () => Math.round(performance.now() - started);
  return {
    end<C extends Record<string, unknown>>(result: C) {
      const summary = { ...result, ms: ms(), run };
      log("run.end", { ...summary, step });
      return summary;
    },
    error(error: string, what: Record<string, unknown> = {}) {
      log("run.error", { error, run, step, ...what });
    },
    ms,
    now,
    run,
    step,
  };
}

export type StepRun = ReturnType<typeof recordStepRun>;

/**
 * A run whose share of his engine's quota is measured (the processing runs, the eval), when the engine has one
 * (`hasQuota`): the quota read as it starts and as it ends, logged on its `run.start` and `run.end` (what it spent is
 * derived from them: `useOf`, run-log.ts). Its tokens are counted either way, from its calls.
 */
export async function metered(
  step: string,
  fields: Record<string, unknown>,
  engine?: Engine
) {
  const read = async () =>
    hasQuota(engine) ? { quota: (await quota(engine)) ?? null } : {};
  const rec = recordStepRun(step, { ...fields, ...(await read()) });
  return {
    ...rec,
    end: async <C extends Record<string, unknown>>(result: C) =>
      rec.end({ ...result, ...(await read()) }),
  };
}

export type Metered = Awaited<ReturnType<typeof metered>>;

/** `work` as `rec`'s whole run: ended ok with what it returns, or failed with its error (thrown on). */
export async function ended<T extends Record<string, unknown>>(
  rec: Metered,
  work: () => Promise<T>
) {
  try {
    const result = await work();
    await rec.end({ ...result, outcome: "ok" });
    return result;
  } catch (e) {
    await rec.end({ error: (e as Error).message, outcome: "failed" });
    throw e;
  }
}

/**
 * A processing run's phases (the nightly's, a backfill week's): `at` is the one running. `step` runs a step, which fails the processing run if
 * it failed anything; `failed` logs the processing run's failure at the phase running and returns its end's fields.
 */
export function processingSteps(rec: Pick<StepRun, "error" | "run" | "step">) {
  let at = "";
  const p = {
    /** The phase running; each one entered is logged (`run.phase`), so the run's record holds its phases in order. */
    get at() {
      return at;
    },
    set at(phase: string) {
      at = phase;
      log("run.phase", { phase, run: rec.run, step: rec.step });
    },
    failed(e: unknown) {
      const error = (e as Error).message;
      rec.error(`${p.at}: ${error}`);
      console.error(`${rec.step} failed at ${p.at}: ${error}`);
      return { error, failedAt: p.at, outcome: "failed" as const };
    },
    async step<T extends { failed: number }>(
      name: string,
      work: () => Promise<T>
    ) {
      p.at = name;
      const summary = await work();
      if (summary.failed > 0) {
        throw new Error(`${summary.failed} failed`);
      }
      return summary;
    },
  };
  return p;
}

/**
 * A run of one memory step (`episodes`, `extract`, `pages`), recorded with its model: its id, today's date, its
 * folder `derived/memory/runs/<step>-<run>` and the counters every step reports (`stats`).
 * `ask` is one model call, counted; `attempt` runs a piece of work whose failure costs only that piece (counted and
 * logged, not thrown: the next run retries it); `error` logs a failure that costs nothing; `end` logs the run as ended
 * and returns the step's summary.
 */
export async function begin(
  step: string,
  tier: Tier,
  fields: Record<string, unknown>,
  engine?: Engine
) {
  const llm = llmFor(tier, engine);
  const model = llmSpec(llm);
  const rec = recordStepRun(`memory.${step}`, { ...fields, model });
  const { now, run } = rec;
  const dir = join(OUT, "runs", `${step}-${run}`);
  await mkdir(dir, { recursive: true });
  const stats = { calls: 0, failed: 0 };
  return {
    async ask(opts: Omit<Parameters<typeof askOnce>[0], "llm" | "run">) {
      const json = await askOnce({ ...opts, llm, run });
      stats.calls += 1;
      return json;
    },
    async attempt<T>(
      work: () => Promise<T>,
      what: Record<string, unknown> = {}
    ) {
      try {
        return await work();
      } catch (e) {
        stats.failed += 1;
        rec.error((e as Error).message, what);
      }
    },
    dir,
    end: <C extends Record<string, unknown>>(counts: C) =>
      rec.end({ ...stats, model, ...counts }),
    error: rec.error,
    llm,
    now,
    run,
    stats,
    today: localDate(now.toISOString()),
  };
}

/**
 * What a call was asked, as one short digest: a result kept with it is still good while the prompt and the input are
 * the same. `prompt` is its name where a change of wording is a new version, or its text where wording moves freely.
 */
export const inputsOf = (prompt: string, input: unknown) =>
  digest("sha256", `${prompt}\n${JSON.stringify(input)}`, 16);

/** A run in progress, as the step functions receive it. */
export type Step = Awaited<ReturnType<typeof begin>>;

/**
 * A model's reply list checked: each entry valid by `schema` and about one thing it was asked about (`asked`, by
 * `keyOf`), once; anything else is counted invalid, never trusted.
 */
export function checkedEntries<T>(
  list: unknown[],
  schema: z.ZodType<T>,
  keyOf: (entry: T) => string,
  asked: (key: string) => boolean
) {
  const entries = new Map<string, T>();
  let invalid = 0;
  for (const raw of list) {
    const r = schema.safeParse(raw);
    if (r.success && asked(keyOf(r.data)) && !entries.has(keyOf(r.data))) {
      entries.set(keyOf(r.data), r.data);
    } else {
      invalid += 1;
    }
  }
  return { entries: [...entries.values()], invalid };
}

/** `list` in pieces of at most `n`. */
export const chunks = <T>(list: T[], n: number) =>
  Array.from({ length: Math.ceil(list.length / n) }, (_, i) =>
    list.slice(i * n, (i + 1) * n)
  );

/**
 * Runs `one` over every batch, as many at once as the step's engine takes (`callsAtOnceOf`), the next starting as one
 * ends, each with its own folder `dir/batch-NNN` for its input and reply. A throw starts no new batch.
 */
export async function inBatches<T>(
  batches: T[],
  step: Pick<Step, "dir" | "llm">,
  one: (batch: T, bdir: string) => Promise<void>
) {
  let next = 0;
  let failed = false;
  const work = async () => {
    while (!failed && next < batches.length) {
      const i = next;
      next += 1;
      const bdir = join(step.dir, `batch-${String(i).padStart(3, "0")}`);
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one worker's batches, one after another
        await mkdir(bdir, { recursive: true });
        await one(batches[i] as T, bdir);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(callsAtOnceOf(step.llm), batches.length) },
      work
    )
  );
}
