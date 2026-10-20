// `bun bench [--models opus,…] [--runs n]`: how well candidate models do Life's deep steps (moments, then extract)
// on one fixed week, against what Life runs (its deep tier, `llmFor`). Each run is the real pipeline on its own
// throwaway copy of the data (empty memory, today's truth/), read with one model through `LIFE_LLM`, in a throwaway
// worktree of this code so nothing shows in his runs; Life's main tier then grades its claims against the week's
// hand-checked facts and his rated statements (scripts/eval.ts). It prints the table and writes nothing of his.
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { llmFor, llmSpec } from "../src/llm";
import { extract } from "../src/memory/extract";
import { locked } from "../src/memory/guard";
import { ratedFacts } from "../src/memory/ledger";
import { moments } from "../src/memory/moments";
import { claimsNow } from "../src/memory/statements";
import type { tally } from "../src/memory/tally";
import { gather } from "../src/memory/units";
import { dayStart } from "../src/memory/zones";
import { exec, git } from "../src/proc";
import { DATA, ROOT } from "../src/truth";

const WEEK = { from: "2026-10-12", to: "2026-10-18" };
const FACTS = join(DATA, "docs/evals/events-2026-10-16.json");
/** Short names for `--models` (an `engine/model/effort` works too). */
const MODELS: Record<string, string> = {
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
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const ERROR_LINE = /^error: .*$/m;

type Counts = ReturnType<typeof tally>["counts"];
const wrong = (c: Counts) => c.contradicted + c.restated;

/** In a copy (`LIFE_DATA`, `LIFE_LLM` set): moments then extract over the week, its claims to claims.jsonl. */
async function readWeek() {
  const since = dayStart(WEEK.from);
  const days = Math.ceil((Date.now() - since.getTime()) / DAY_MS) + 1;
  const done = await locked(async () => {
    const evidence = await gather(since);
    const week = {
      ...evidence,
      built: evidence.built.filter((b) => b.unit.date <= WEEK.to),
    };
    const m = await moments({ days, evidence: week });
    const e = await extract({ days, evidence: week });
    const claims = (await claimsNow()).filter(
      (c) => c.date >= WEEK.from && c.date <= WEEK.to
    );
    await Bun.write(
      join(DATA, "claims.jsonl"),
      claims
        .map((c) => JSON.stringify({ date: c.date, id: c.claim, text: c.text }))
        .join("\n")
    );
    return {
      calls: m.calls + e.calls,
      claims: claims.length,
      failed: m.failed + e.failed,
      runs: [m.run, e.run],
    };
  });
  if (!done) {
    throw new Error("a run holds this copy's lock");
  }
  console.log(JSON.stringify(done));
}

/** One process in the bench's worktree, on one copy, with one model; its last stdout line is JSON. */
async function run(code: string, data: string, llm: string, args: string[]) {
  const r = await exec(["bun", ...args], {
    cwd: code,
    env: { ...process.env, LIFE_DATA: data, LIFE_LLM: llm },
    timeout: 3 * HOUR_MS,
  });
  if (r.code !== 0) {
    const why = r.stderr.match(ERROR_LINE)?.[0] ?? r.stderr.trim().slice(-300);
    throw new Error(`${args.join(" ")} exited ${r.code}: ${why}`);
  }
  return JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
}

/** What a run's model calls cost, from the worktree's log; codex reports none (his subscription). */
async function cost(code: string, runs: string[]) {
  const dir = join(code, "derived", "log");
  const costs = (
    await Promise.all(
      [...new Bun.Glob("*.jsonl").scanSync(dir)].map((f) =>
        Bun.file(join(dir, f)).text()
      )
    )
  )
    .join("\n")
    .split("\n")
    .filter(Boolean)
    .map(
      (l) => JSON.parse(l) as { costUsd?: number; kind: string; run: string }
    )
    .filter((l) => l.kind === "model.run" && runs.includes(l.run))
    .flatMap((l) => (l.costUsd === undefined ? [] : [l.costUsd]));
  return costs.length > 0
    ? `$${costs.reduce((a, b) => a + b, 0).toFixed(2)}`
    : "subscription";
}

async function bench(models: string[], runs: number) {
  const hour = new Date().getHours() + new Date().getMinutes() / 60;
  if (hour >= 1.5 && hour < 6) {
    throw new Error("the nightly runs from 01:30 to 06:00: bench after it");
  }
  const named: Record<string, string> = {
    ...MODELS,
    [BASELINE]: llmSpec(await llmFor("deep")),
  };
  const judge = llmSpec(await llmFor("main"));
  const main = dirname(
    resolve(
      ROOT,
      git(ROOT, ["rev-parse", "--git-common-dir"]).stdout.toString().trim()
    )
  );
  const tmp = await mkdtemp(join(tmpdir(), "life-bench-"));
  const code = join(tmp, "code");
  const base = join(tmp, "base");
  try {
    git(ROOT, ["worktree", "add", "--detach", code, "HEAD"]);
    await mkdir(join(code, "derived"), { recursive: true });
    await symlink(join(main, "node_modules"), join(code, "node_modules"));
    await symlink(join(main, ".env"), join(code, ".env"));
    await symlink(
      join(main, "derived", "watch"),
      join(code, "derived", "watch")
    );
    await mkdir(join(base, "memory"), { recursive: true });
    for (const p of SEED) {
      // biome-ignore lint/performance/noAwaitInLoops: five small copies
      await cp(join(DATA, p), join(base, p), { recursive: true });
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
            llm: named[m] ?? m,
            model: m,
          })
        )
    );
    const rows = await Promise.all(
      plan.map(async (p) => {
        const data = join(tmp, p.label);
        await exec(["cp", "-cR", base, data]);
        const started = performance.now();
        try {
          const read = await run(code, data, p.llm, [
            "scripts/bench.ts",
            "--read-week",
          ]);
          const minutes = Math.round((performance.now() - started) / 60_000);
          const claims = join(data, "claims.jsonl");
          const graded = (file: string) =>
            run(code, data, judge, [
              "scripts/eval.ts",
              file,
              claims,
              "--json",
            ]) as Promise<Counts>;
          const [held, stated] = await Promise.all([
            graded(FACTS),
            graded(ratedFile),
          ]);
          return {
            ...p,
            calls: read.calls as number,
            claims: read.claims as number,
            cost: await cost(code, read.runs),
            failed: read.failed as number,
            held,
            minutes,
            stated,
          };
        } catch (e) {
          return { ...p, error: (e as Error).message };
        }
      })
    );
    console.log(table(rows, { facts, judge, rated: rated.length }));
  } finally {
    git(ROOT, ["worktree", "remove", "--force", code]);
    await rm(tmp, { force: true, recursive: true });
  }
}

type Row = {
  label: string;
  llm: string;
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
export function table(
  rows: Row[],
  about: { facts: number; judge: string; rated: number }
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
      return `| ${r.label} | ${r.llm} | failed: ${r.error?.replaceAll("|", "/").slice(0, 200)} |||||||`;
    }
    return `| ${r.label} | ${r.llm} | ${r.held.held}/${r.held.trues} | ${wrong(r.held)} | ${versus(r, r.held.held)} | ${r.stated.held}/${r.stated.trues}, ${wrong(r.stated)} wrong | ${r.claims} | ${r.calls}${r.failed ? ` (${r.failed} failed: invalid)` : ""} | ${r.minutes} min | ${r.cost} |`;
  };
  return [
    `# Bench ${WEEK.from} to ${WEEK.to} (${new Date().toISOString().slice(0, 16)}Z, code ${git(ROOT, ["rev-parse", "--short", "HEAD"]).stdout.toString().trim()})`,
    "",
    `Each run: moments then extract over the week on an empty copy (today's truth/), one model; judge ${about.judge}. Facts: the ${about.facts} hand-checked facts of events-2026-10-16.json; rated: his ${about.rated} rated statements of the week as facts. Wrong = a false one stated or a true one contradicted.`,
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
    await bench(
      (values.models ?? Object.keys(MODELS).join(",")).split(","),
      Number(values.runs ?? 1)
    );
  }
}
