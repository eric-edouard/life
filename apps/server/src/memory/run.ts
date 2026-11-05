import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { clock } from "../core/clock";
import { log } from "../core/log";
import type { Engine } from "../core/names";
import { OWNER_DATA_DIR } from "../core/paths";
import { git } from "../core/proc";
import {
  askOnce,
  hasQuota,
  llmFor,
  llmSpec,
  quota,
  type Tier,
} from "../models/llm";
import { INFERRED_USE_AT, type InferredPerson } from "../records/observation";
import { isUnderway } from "../records/truth";
import { OUT, runId } from "./ledger";
import type { Truth } from "./read-truth";
import { localDate } from "./zones";

// What every memory step shares: the run (its id, folder, counters, failures and end), the batches of model calls and
// the context a run sends first.

const PARALLEL = 4;

/**
 * A run of any kind, logged in derived/log as started now with `fields`: its id is its start instant (`runId`). `error`
 * logs a failure of the run (`what.step` names a sub-step: memory.nightly.actions); `end` logs its end with its duration
 * and returns what it logged (`step` aside). No model: the sweeps use it as is, the steps through `begin`.
 */
export function record(step: string, fields: Record<string, unknown>) {
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

export type RunRecord = ReturnType<typeof record>;

/**
 * A run whose share of his engine's quota is measured (the sweeps, the eval), when the engine has one
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
  const rec = record(step, { ...fields, ...(await read()) });
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
 * A sweep's phases (the nightly's, the midday's): `at` is the one running. `step` runs a step, which fails the sweep if
 * it failed anything; `failed` logs the sweep's failure at the phase running and returns its end's fields.
 */
export function phases(rec: Pick<RunRecord, "error" | "run" | "step">) {
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
  fields: Record<string, unknown>
) {
  const llm = llmFor(tier);
  const model = llmSpec(llm);
  const rec = record(`memory.${step}`, { ...fields, model });
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

/** Runs `one` over every batch, a few at a time, each with its own folder `dir/batch-NNN` for its input and reply. */
export async function inBatches<T>(
  batches: T[],
  dir: string,
  one: (batch: T, bdir: string) => Promise<void>
) {
  for (let i = 0; i < batches.length; i += PARALLEL) {
    // biome-ignore lint/performance/noAwaitInLoops: a few calls at a time, not all at once
    await Promise.all(
      batches.slice(i, i + PARALLEL).map(async (b, j) => {
        const bdir = join(dir, `batch-${String(i + j).padStart(3, "0")}`);
        await mkdir(bdir, { recursive: true });
        await one(b, bdir);
      })
    );
  }
}

/** Who the owner is and his areas: the start of the context every memory call of a run shares (so it is cached). */
export function meContext(truth: Truth) {
  return {
    areas: truth.areas.map((a) => ({ id: a.id, name: a.name })),
    me: truth.me.text,
  };
}

/**
 * The map as the episodes, extract and pages prompts name it: the people on his map (with those Life inferred) and his
 * projects, every ref a reply may use (`map`). A call's `<context>` (the same for every call of a run, so it is cached)
 * shows the owner, his areas, the people close to him now (`shown`, `contextPeopleBy`) and the projects underway; the
 * others a call involves come in its input (`involvedOf`), so the context stays small as the map grows.
 */
export function refContext(
  truth: Truth,
  inferred: InferredPerson[],
  close: ReadonlySet<string>,
  shown: ReadonlySet<string>
) {
  // `close`: close to him personally (`personallyClose`), so what is between them weighs more.
  const flag = (ref: string) => (close.has(ref) ? { close: true } : {});
  const underway = new Set(
    truth.projects.filter(isUnderway).map((p) => `project:${p.id}`)
  );
  const map = {
    people: [
      ...truth.people.map((p) => ({
        aliases: p.aliases,
        name: p.name,
        ref: `person:${p.id}`,
        relation: p.relation,
        ...flag(`person:${p.id}`),
      })),
      ...inferred
        .filter((p) => p.confidence >= INFERRED_USE_AT)
        .map((p) => ({
          aliases: [] as string[],
          name: p.name,
          ref: `person:${p.id}`,
          relation: `${p.relation} (inferred)`,
          ...flag(`person:${p.id}`),
        })),
    ],
    projects: truth.projects.map((p) => ({
      area: p.area,
      description: p.notes.split("\n\n")[0]?.replace(/\s+/g, " ").slice(0, 300),
      name: p.name,
      people: p.people.map((id) => truth.people.find((x) => x.id === id)?.name),
      ref: `project:${p.id}`,
      status: p.status,
    })),
  };
  return {
    context: {
      ...meContext(truth),
      people: map.people.filter((p) => shown.has(p.ref)),
      projects: map.projects.filter((p) => underway.has(p.ref)),
    },
    map,
  };
}

/** The map's entries a call involves (`refs`) that its context leaves out: its input's `involved`. */
export function involvedOf(
  { context, map }: ReturnType<typeof refContext>,
  refs: ReadonlySet<string>
) {
  const inContext = new Set(
    [...context.people, ...context.projects].map((x) => x.ref)
  );
  const pick = <T extends { ref: string }>(list: T[]) =>
    list.filter((x) => refs.has(x.ref) && !inContext.has(x.ref));
  return { people: pick(map.people), projects: pick(map.projects) };
}

/** Commits the given paths of the data repo (only those that exist), with a plain message. Nothing to commit is fine. */
export function commitMemory(all: string[], message: string) {
  // Its own repo's root, never a folder git would resolve to some repo above it (a test run's copy, a subfolder).
  if (!existsSync(join(OWNER_DATA_DIR, ".git"))) {
    throw new Error(
      `${OWNER_DATA_DIR} is not a repo of its own: nothing is committed`
    );
  }
  if (git(OWNER_DATA_DIR, ["remote"]).stdout.toString().trim()) {
    throw new Error(
      `${OWNER_DATA_DIR}'s repo has a remote: his data is never pushed`
    );
  }
  const paths = all.filter((p) => existsSync(join(OWNER_DATA_DIR, p)));
  git(OWNER_DATA_DIR, ["add", "--", ...paths]);
  if (
    git(OWNER_DATA_DIR, ["diff", "--cached", "--quiet", "--", ...paths])
      .exitCode === 0
  ) {
    return false;
  }
  const out = git(OWNER_DATA_DIR, [
    "commit",
    "-q",
    "-m",
    message,
    "--",
    ...paths,
  ]);
  if (out.exitCode !== 0) {
    throw new Error(`git commit failed: ${out.stderr.toString().trim()}`);
  }
  return true;
}
