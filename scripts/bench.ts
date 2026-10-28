// `bun bench [--models opus,…] [--runs n]`: how well candidate models do Life's deep steps (moments, then extract)
// on one fixed week, against what Life runs (his engine's deep tier). Each run is the real pipeline on its own
// throwaway copy of the data (empty memory, today's truth/), read with his engine or one model through `LIFE_LLM`, in its own
// throwaway worktree of this code (its log and run folders apart, nothing in his runs); Life's main tier then grades its claims against the week's
// hand-checked facts and his rated statements (scripts/eval.ts). It prints the table and writes nothing of his.

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
import { extract } from "@life/server/src/memory/extract";
import { ratedFacts } from "@life/server/src/memory/ledger";
import { locked } from "@life/server/src/memory/memory-lock";
import { moments } from "@life/server/src/memory/moments";
import { spareQuota } from "@life/server/src/memory/schedule";
import { claimsNow } from "@life/server/src/memory/statements";
import type { tally } from "@life/server/src/memory/tally";
import { gather } from "@life/server/src/memory/units";
import { readPeople } from "@life/server/src/memory/who";
import { llmFor, llmSpec } from "@life/server/src/models/llm";

const WEEK = { from: "2026-10-12", to: "2026-10-18" };
const FACTS = join(OWNER_DATA_DIR, "docs/evals/events-2026-10-16.json");
/** Short names for `--models` (an `engine/model/effort` works too). */
// Benched 20 Oct and dropped: MiMo V2.6 Pro (at high it spends the whole token budget reasoning, at medium its host
// errors) and DeepSeek V4 Pro 0813 (below every Sol run, slower and dearer than Flash). Through allmodels since 28 Oct,
// each on an fp8 host.
const MODELS: Record<string, string> = {
  "deepseek-flash":
    "allmodels/deepseek/deepseek-v4.1-flash-abliterated@hopper/high",
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
const wrong = (c: Counts) => c.contradicted + c.restated;

/** In a copy (`LIFE_OWNER_DATA_DIR`, `LIFE_LLM` set): moments then extract over the week, its claims to claims.jsonl. */
async function readWeek() {
  const done = await locked(async () => {
    // The week's evidence: gather cuts its units to the window.
    const week = await gather(
      { from: WEEK.from, to: WEEK.to },
      await readPeople()
    );
    const m = await moments(week);
    const e = await extract(week);
    const claims = (await claimsNow()).filter(
      (c) => c.date >= WEEK.from && c.date <= WEEK.to
    );
    await Bun.write(
      join(OWNER_DATA_DIR, "claims.jsonl"),
      claims
        .map((c) => JSON.stringify({ date: c.date, id: c.ref, text: c.text }))
        .join("\n")
    );
    // This worktree's log holds this run alone so far: its calls' cost (codex reports none).
    const costs = (await logDays(LOG_DIR))
      .flatMap((n) => logEvents<{ costUsd?: number }>(n, "model.run"))
      .flatMap((l) => (typeof l.costUsd === "number" ? [l.costUsd] : []));
    return {
      calls: m.calls + e.calls,
      claims: claims.length,
      cost:
        costs.length > 0
          ? `$${costs.reduce((a, b) => a + b, 0).toFixed(2)}`
          : "subscription",
      failed: m.failed + e.failed,
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
    throw new Error(`${args.join(" ")} exited ${r.code}: ${why}`);
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
  await mkdir(join(dir, "derived"), { recursive: true });
  await symlink(join(mainCheckout(), ".env"), join(dir, ".env"));
  for (const p of state) {
    // biome-ignore lint/performance/noAwaitInLoops: a few links
    await symlink(join(LIFE_STATE_DIR, p), join(dir, "derived", p));
  }
}

async function bench(models: string[], runs: number) {
  const tmp = await mkdtemp(join(tmpdir(), "life-bench-"));
  const base = join(tmp, "base");
  const worktrees: string[] = [];
  try {
    await mkdir(join(base, "memory"), { recursive: true });
    for (const p of SEED) {
      // biome-ignore lint/performance/noAwaitInLoops: five small copies
      await cp(join(OWNER_DATA_DIR, p), join(base, p), { recursive: true });
    }
    const rated = ratedFacts()
      .filter((f) => f.date >= WEEK.from && f.date <= WEEK.to)
      .map((f) => ({ fact: f.fact, id: f.id, true: f.true }));
    const ratedFile = join(tmp, "rated.json");
    await Bun.write(ratedFile, JSON.stringify({ ...WEEK, facts: rated }));
    const facts = (await Bun.file(FACTS).json()).facts.length as number;
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
            "--read-week",
          ]);
          const minutes = Math.round((performance.now() - started) / MIN);
          const claims = join(data, "claims.jsonl");
          const graded = (file: string) =>
            run(code, data, undefined, [
              "scripts/eval.ts",
              file,
              claims,
              "--json",
            ]) as Promise<Counts>;
          // One after the other: an eval's run folder is named by the millisecond it starts.
          const held = await graded(FACTS);
          const stated = await graded(ratedFile);
          return {
            ...p,
            calls: read.calls as number,
            claims: read.claims as number,
            cost: read.cost as string,
            failed: read.failed as number,
            held,
            llm: read.model as string,
            minutes,
            stated,
          };
        } catch (e) {
          return { ...p, error: (e as Error).message };
        }
      })
    );
    console.log(factTable(rows, { facts, rated: rated.length }));
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
}>;

/** One line per run; a held count within the baseline's own spread (or 3) of its mean is a tie. */
export function factTable(
  rows: Row[],
  about: { facts: number; rated: number }
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
    if (!(r.held && r.stated)) {
      return `| ${r.label} | ${r.llm ?? "his engine"} | failed: ${r.error?.replaceAll("|", "/").slice(0, 200)} |||||||`;
    }
    return `| ${r.label} | ${r.llm ?? "his engine"} | ${r.held.held}/${r.held.trues} | ${wrong(r.held)} | ${versus(r, r.held.held)} | ${r.stated.held}/${r.stated.trues}, ${wrong(r.stated)} wrong | ${r.claims} | ${r.calls}${r.failed ? ` (${r.failed} failed: invalid)` : ""} | ${r.minutes} min | ${r.cost} |`;
  };
  return [
    `# Bench ${WEEK.from} to ${WEEK.to} (${clock().toISOString().slice(0, 16)}Z, code ${git(LIFE_CODE_DIR, ["rev-parse", "--short", "HEAD"]).stdout.toString().trim()})`,
    "",
    `Each run: moments then extract over the week on an empty copy (today's truth/), one model; judge ${rows.find((r) => r.held)?.held?.judge ?? "his engine's main tier"}. Facts: the ${about.facts} hand-checked facts of events-2026-10-16.json; rated: his ${about.rated} rated statements of the week as facts. Wrong = a false one stated or a true one contradicted.`,
    "",
    `| run | model | true facts held | wrong (of ${about.facts}) | vs baseline | rated statements | claims | calls | time | cost |`,
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(line),
  ].join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      models: { type: "string" },
      "read-week": { type: "boolean" },
      runs: { type: "string" },
    },
  });
  if (values["read-week"]) {
    await readWeek();
  } else {
    await spareQuota();
    await bench(
      (values.models ?? Object.keys(MODELS).join(",")).split(","),
      Number(values.runs ?? 1)
    );
  }
}
