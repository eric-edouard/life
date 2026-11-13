// `bun bench [--models opus --models …] [--runs n] [--judge engine/model/effort]`: how well candidate models do Life's deep steps (episodes, then extract)
// on the hand-checked days (the truth set, ~/Life/docs/evals/truth-*.json), against what Life runs (his engine's deep tier). Each run is the real pipeline on its own
// throwaway copy of the data (empty memory, today's truth/), read with his engine or one model through `LIFE_LLM`, in its own
// throwaway worktree of this code (its log and run folders apart, nothing in his runs); Life's main tier (or `--judge`, to
// keep one judge across benches when his engine changes) then grades its claims against the days' hand-checked facts
// and his rated statements (scripts/eval.ts), and its episodes against their timelines (scripts/timeline.ts, by code).
// It prints the table and writes nothing of his.

import { cpSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { clock, HOUR, MIN } from "@life/server/src/core/clock";
import { LOG_DIR, logDays, logEvents } from "@life/server/src/core/log";
import {
  LIFE_CODE_DIR,
  LIFE_STATE_DIR,
  OWNER_DATA_DIR,
} from "@life/server/src/core/paths";
import { exec, execOk, git, gitOut } from "@life/server/src/core/proc";
import { memoryLinesNow } from "@life/server/src/memory/doubts";
import { episodes } from "@life/server/src/memory/episodes";
import { extract } from "@life/server/src/memory/extract";
import { answeredFactChecks } from "@life/server/src/memory/memory-files";
import { locked } from "@life/server/src/memory/memory-lock";
import { spareQuota } from "@life/server/src/memory/schedule";
import type { tally } from "@life/server/src/memory/tally";
import { gather } from "@life/server/src/memory/units";
import { readPeople } from "@life/server/src/memory/who";
import { llmFor, llmSpec } from "@life/server/src/models/llm";
import { add, NONE, type Tokens } from "@life/server/src/models/model-call";
import { newestTurn } from "@life/server/src/sources/lifelog";
import { TruthSet, type timelineScore } from "./timeline";

const EVALS = join(OWNER_DATA_DIR, "docs/evals");
/** The truth set: each file one or more days, with their facts and timeline. */
const truthFiles = async () =>
  (await Array.fromAsync(new Bun.Glob("truth-*.json").scan(EVALS)))
    .toSorted()
    .map((f) => join(EVALS, f));
const readTruth = async (file: string) =>
  TruthSet.parse(await Bun.file(file).json());
/** Short names for `--models` (an `engine/model/effort` works too). */
// Benched 20 Oct and dropped: MiMo V2.6 Pro (at high it spends the whole token budget reasoning, at medium its host
// errors) and DeepSeek V4 Pro 0813 (below every Sol run, slower and dearer than Flash). Through allmodels since 28 Oct:
// DeepSeek Flash as Life runs it (his hosts, his order), GLM-5.3 on an fp8 host.
const MODELS: Record<string, string> = {
  "deepseek-flash": llmSpec(llmFor("deep", "allmodels")),
  glm: "allmodels/z-ai/glm-5.3-abliterated@abliteration/high",
  opus: "claude/opus/medium",
};
/** What Life runs, always benched, at least twice so its own spread shows. */
const BASELINE = "life";
/** What a copy starts from: no memory, only what is his or describes his sources (no corrections: they hide claims). */
const SEED = [
  "truth",
  "memory/zones.jsonl",
  "memory/files.jsonl",
  "memory/people-inferred.jsonl",
  "memory/repos-inferred.jsonl",
];
const ERROR_LINE = /^error: .*$/m;

/** What eval.ts --json prints: the counts and the judge that gave them. */
type Counts = ReturnType<typeof tally>["counts"] & { judge?: string };
type TimelineCounts = ReturnType<typeof timelineScore>["counts"];
const wrong = (c: Counts) => c.contradicted + c.restated;
/** Counts of several days as one: numbers added, at any depth; anything else (the judge) kept from the first. */
function summed<T>(all: T[]): T {
  return all.reduce((a, b) => {
    if (typeof a === "number") {
      return (a + (b as number)) as T;
    }
    if (!a || typeof a !== "object") {
      return a;
    }
    return Object.fromEntries(
      Object.entries(a).map(([k, v]) => [
        k,
        summed([v, (b as Record<string, unknown>)[k]]),
      ])
    ) as T;
  });
}

/** In a copy (`LIFE_OWNER_DATA_DIR`, `LIFE_LLM` set): episodes then extract over each truth file's window (the files are passed in: the copy has no docs), its claims to claims.jsonl. */
async function readDays(files: string[]) {
  const windows = await Promise.all(files.map(readTruth));
  const done = await locked(async () => {
    const people = await readPeople();
    const read = { calls: 0, failed: 0 };
    for (const w of windows) {
      // The window's evidence: gather cuts its units to it.
      // biome-ignore lint/performance/noAwaitInLoops: one window at a time, as the nightly reads days
      const days = await gather({ from: w.from, to: w.to }, people);
      // A store not read (one locked by another run) leaves the copy with facts but no units: a failed run, not a score.
      if (days.failed.length > 0) {
        throw new Error(`could not read ${days.failed.join(", ")}`);
      }
      const m = await episodes(days);
      const e = await extract(days);
      read.calls += m.calls + e.calls;
      read.failed += m.failed + e.failed;
    }
    const claims = (await memoryLinesNow()).filter((c) =>
      windows.some((w) => c.date >= w.from && c.date <= w.to)
    );
    await Bun.write(
      join(OWNER_DATA_DIR, "claims.jsonl"),
      claims
        .map((c) => JSON.stringify({ date: c.date, id: c.ref, text: c.text }))
        .join("\n")
    );
    // This worktree's log holds this run alone so far: its calls' cost (claude's alone report one), else their tokens.
    const calls = (await logDays(LOG_DIR)).flatMap((n) =>
      logEvents<{ costUsd?: number; tokens?: Tokens }>(n, "model.run")
    );
    const costs = calls.flatMap((l) =>
      typeof l.costUsd === "number" ? [l.costUsd] : []
    );
    const tokens = calls.reduce((t, l) => add(t, l.tokens ?? NONE), NONE);
    return {
      ...read,
      claims: claims.length,
      cost:
        costs.length > 0
          ? `$${costs.reduce((a, b) => a + b, 0).toFixed(2)}`
          : `${Math.round((tokens.input + tokens.output) / 1e3)}k tokens`,
      model: llmSpec(llmFor("deep")),
    };
  });
  if (!done) {
    throw new Error("a run holds this copy's lock");
  }
  console.log(JSON.stringify(done));
}

/** One process in the bench's worktree, on one copy, with his engine or one model; its last stdout line is JSON. */
async function run(
  code: string,
  data: string,
  llm: string | undefined,
  args: string[]
) {
  const r = await exec(["bun", ...args], {
    cwd: code,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== "LIFE_LLM")
      ),
      LIFE_OWNER_DATA_DIR: data,
      ...(llm ? { LIFE_LLM: llm } : {}),
      // Its worktree's own state, whatever this process was given.
      LIFE_STATE_DIR: join(code, "derived"),
    },
    timeout: 3 * HOUR,
  });
  if (r.code !== 0) {
    const why = r.stderr.match(ERROR_LINE)?.[0] ?? r.stderr.trim().slice(-300);
    throw new Error(`${why} (${args[0]} ${args[1]} exited ${r.code})`);
  }
  return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
}

/** The main checkout (this repo's first worktree): its .env. */
const mainCheckout = () =>
  dirname(
    gitOut(LIFE_CODE_DIR, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])
  );

/**
 * This code at HEAD in `dir`, a throwaway worktree, with its own dependencies (a link to the main checkout's would load
 * the main checkout's code: the workspace packages link back into it), installed without scripts (`prepare` writes the
 * git config every worktree shares, which parallel checkouts would race on), the main checkout's .env, and `state` from
 * this process's state dir (`LIFE_STATE_DIR`: production's when run from the main checkout) in its own derived/.
 */
export async function checkout(dir: string, state: string[]) {
  gitOut(LIFE_CODE_DIR, ["worktree", "add", "--detach", dir, "HEAD"]);
  await execOk(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: dir,
  });
  await symlink(join(mainCheckout(), ".env"), join(dir, ".env"));
  await linkState(join(dir, "derived"), state);
}

/**
 * A state dir at `to` that is this process's (`LIFE_STATE_DIR`) for the entries named, by links, and its own for the
 * rest: what a child run there logs or writes as state never lands in this process's.
 */
export async function linkState(to: string, state: string[]) {
  await mkdir(to, { recursive: true });
  for (const p of state) {
    // biome-ignore lint/performance/noAwaitInLoops: a few links
    await symlink(join(LIFE_STATE_DIR, p), join(to, p));
  }
}

async function bench(models: string[], runs: number, judge?: string) {
  const tmp = await mkdtemp(join(tmpdir(), "life-bench-"));
  const base = join(tmp, "base");
  const worktrees: string[] = [];
  try {
    await mkdir(join(base, "memory"), { recursive: true });
    for (const p of SEED) {
      // biome-ignore lint/performance/noAwaitInLoops: five small copies
      await cp(join(OWNER_DATA_DIR, p), join(base, p), { recursive: true });
    }
    const files = await truthFiles();
    const windows = await Promise.all(files.map(readTruth));
    // The runs read the voice store linked from this process's state: a worktree's own is stale unless copied.
    const last =
      windows
        .map((w) => w.to)
        .toSorted()
        .at(-1) ?? "";
    if ((newestTurn() ?? "") < last) {
      throw new Error(
        `the voice store in ${LIFE_STATE_DIR}/watch ends before ${last}: copy the live one there`
      );
    }
    const days = windows.map((w) =>
      w.from === w.to ? w.from : `${w.from}–${w.to}`
    );
    const rated = answeredFactChecks()
      .filter((f) => windows.some((w) => f.date >= w.from && f.date <= w.to))
      .map((f) => ({ date: f.date, fact: f.fact, id: f.id, true: f.true }));
    const ratedFile = join(tmp, "rated.json");
    // eval.ts takes one window: the first day to the last, holding only the truth days' statements.
    await Bun.write(
      ratedFile,
      JSON.stringify({
        facts: rated,
        from: windows.map((w) => w.from).toSorted()[0],
        to: windows
          .map((w) => w.to)
          .toSorted()
          .at(-1),
      })
    );
    const facts = (
      await Promise.all(
        files.map(
          async (f) => (await Bun.file(f).json()).facts.length as number
        )
      )
    ).reduce((a, b) => a + b, 0);
    const plan = [BASELINE, ...models.filter((m) => m !== BASELINE)].flatMap(
      (m) =>
        Array.from(
          { length: m === BASELINE ? Math.max(2, runs) : runs },
          (_, k) => ({
            label: `${m.replaceAll("/", "-")}${k + 1}`,
            llm: m === BASELINE ? undefined : (MODELS[m] ?? m),
            model: m,
          })
        )
    );
    const rows = await Promise.all(
      plan.map(async (p) => {
        const code = join(tmp, p.label, "code");
        const data = join(tmp, p.label, "data");
        worktrees.push(code);
        const started = performance.now();
        try {
          await checkout(code, ["watch", "settings.json"]);
          cpSync(base, data, { recursive: true });
          const read = await run(code, data, p.llm, [
            "scripts/bench.ts",
            "--read-days",
            ...files,
          ]);
          const minutes = Math.round((performance.now() - started) / MIN);
          const claims = join(data, "claims.jsonl");
          const graded = (file: string) =>
            run(code, data, judge, [
              "scripts/eval.ts",
              file,
              claims,
              "--json",
            ]) as Promise<Counts>;
          // One after the other: an eval's run folder is named by the millisecond it starts.
          const held: Counts[] = [];
          for (const f of files) {
            // biome-ignore lint/performance/noAwaitInLoops: see above
            held.push(await graded(f));
          }
          const stated = await graded(ratedFile);
          const timeline = await Promise.all(
            files.map(
              (f) =>
                run(code, data, undefined, [
                  "scripts/timeline.ts",
                  f,
                  "--json",
                ]) as Promise<TimelineCounts>
            )
          );
          return {
            ...p,
            calls: read.calls as number,
            claims: read.claims as number,
            cost: read.cost as string,
            failed: read.failed as number,
            held: summed(held),
            llm: read.model as string,
            minutes,
            stated,
            timeline: summed(timeline),
          };
        } catch (e) {
          return { ...p, error: (e as Error).message };
        }
      })
    );
    console.log(factTable(rows, { days, facts, rated: rated.length }));
  } finally {
    for (const dir of worktrees) {
      git(LIFE_CODE_DIR, ["worktree", "remove", "--force", dir]);
    }
    await rm(tmp, { force: true, recursive: true });
  }
}

type Row = {
  label: string;
  llm?: string;
  model: string;
  error?: string;
} & Partial<{
  calls: number;
  claims: number;
  cost: string;
  failed: number;
  held: Counts;
  minutes: number;
  stated: Counts;
  timeline: TimelineCounts;
}>;

/** One line per run; a held count within the baseline's own spread (or 3) of its mean is a tie. */
export function factTable(
  rows: Row[],
  about: { days: string[]; facts: number; rated: number }
) {
  const base = rows.flatMap((r) =>
    r.model === BASELINE && r.held ? [r.held.held] : []
  );
  const mean = base.reduce((a, b) => a + b, 0) / base.length;
  const band = Math.max(3, Math.max(...base) - Math.min(...base));
  const versus = (r: Row, held: number) => {
    if (r.model === BASELINE) {
      return "baseline";
    }
    if (base.length === 0) {
      return "no baseline";
    }
    const d = held - mean;
    return Math.abs(d) <= band ? "tie" : `${d > 0 ? "+" : ""}${d.toFixed(1)}`;
  };
  const line = (r: Row) => {
    if (!(r.held && r.stated && r.timeline)) {
      return `| ${r.label} | ${r.llm ?? "his engine"} | failed: ${r.error?.replaceAll("|", "/").slice(0, 200)} |||||||||`;
    }
    const t = r.timeline;
    return `| ${r.label} | ${r.llm ?? "his engine"} | ${r.held.held}/${r.held.trues} | ${wrong(r.held)} | ${r.held.both} | ${versus(r, r.held.held)} | ${t.found}/${t.truth}, ${t.merged} merged, ${t.extra} extra, ${t.duplicates} dup, start ${t.start.ok}/${t.start.checked}, end ${t.end.ok}/${t.end.checked}, place ${t.place.ok}/${t.place.checked} | ${r.stated.held}/${r.stated.trues}, ${wrong(r.stated)} wrong, ${r.stated.both} kept both | ${r.claims} | ${r.calls}${r.failed ? ` (${r.failed} failed)` : ""} | ${r.minutes} min | ${r.cost} |`;
  };
  return [
    `# Bench ${about.days.join(", ")} (${clock().toISOString().slice(0, 16)}Z, code ${git(LIFE_CODE_DIR, ["rev-parse", "--short", "HEAD"]).stdout.toString().trim()})`,
    "",
    `Each run: episodes then extract over each truth day on an empty copy (today's truth/), one model; judge ${rows.find((r) => r.held)?.held?.judge ?? "his engine's main tier"}. Facts: the ${about.facts} hand-checked facts of the truth set; rated: his ${about.rated} rated statements of those days as facts. Each fact is judged as of its day (a rated statement's), against the claims said by then. Wrong = a false one stated or a true one contradicted; kept both = stated and contradicted, a contradiction stored. Timeline: the episodes against the hand-checked ones, by code (scripts/timeline.ts): found one to one, merged into another, extra, duplicates; start and end within 15 min, place within 150 m.`,
    "",
    `| run | model | true facts held | wrong (of ${about.facts}) | kept both | vs baseline | timeline | rated statements | claims | calls | time | cost |`,
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(line),
  ].join("\n");
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    options: {
      judge: { type: "string" },
      // One model per value: an allmodels host list has commas of its own (`model@refuseless,hopper`).
      models: { multiple: true, type: "string" },
      "read-days": { type: "boolean" },
      runs: { type: "string" },
    },
  });
  if (values["read-days"]) {
    await readDays(positionals);
  } else {
    await spareQuota();
    await bench(
      values.models ?? Object.keys(MODELS),
      Number(values.runs ?? 1),
      values.judge
    );
  }
}
