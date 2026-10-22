// `bun scripts/bench-agent.ts [cases.json] [--only id,…] [--engine codex|claude]`: the agent, end to end, on his past asks.
// Each case is one ask of memory/actions.jsonl, replayed in the world as it was then: a clone of ~/Life at its last
// commit before the ask, the ledger cut at the ask, the lifelog store cut at its instant, the index rebuilt from that
// copy, and the clock frozen there (`LIFE_NOW`, apps/server/src/clock.ts) in a throwaway worktree of this code. A headless agent on
// his subscription gets Life's connector, frozen and dry (mcp.ts), as its only tools, and the playbook through `tasks`:
// Codex's main tier (Sol), as close as it gets to the agent, a ChatGPT agent (his rule). `--engine claude` only checks the
// harness: its table says so and is never the agent's result. Graded by code first (the ids its tool answers cited, the
// calls it made, the tools it must not call), then by the same engine's judge on what it said (`contain`, and
// `not.contain`: nothing invented).
// Prints one row per case; writes nothing of his. `--serve` is the frozen connector over stdio, for the agent.
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { FROZEN } from "../apps/server/src/clock";
import { nextEvent } from "../apps/server/src/events";
import { askOnce, llmFor } from "../apps/server/src/llm";
import { recentEvents } from "../apps/server/src/log";
import { buildServer } from "../apps/server/src/mcp";
import { spareQuota } from "../apps/server/src/memory/guard";
import {
  ACTIONS,
  linesOf,
  OUT,
  parseAction,
} from "../apps/server/src/memory/ledger";
import { ended, metered } from "../apps/server/src/memory/run";
import { judge, tally } from "../apps/server/src/memory/tally";
import { localDate, zoneAt } from "../apps/server/src/memory/zones";
import { exec, git, gitOut } from "../apps/server/src/proc";
import { Engine } from "../apps/server/src/schema";
import { DATA, ROOT, STATE } from "../apps/server/src/truth";
import { checkout } from "./bench";

const CASES = join(DATA, "docs/evals/agent-bench-cases.json");
const Case = z.object({
  /** The ask in memory/actions.jsonl. */
  ask: z.string().regex(/^act_[0-9a-f]{12}$/),
  /** Calls it must make: the tool, and arguments each holding the given text (any case) or equal to the value. */
  call: z
    .array(
      z.object({
        args: z.record(z.string(), z.unknown()).default({}),
        tool: z.string(),
      })
    )
    .default([]),
  /** Facts its reply, reminders or task notes must state. */
  contain: z.array(z.string()).default([]),
  /** Ids its tool answers must cite: what it had to read. */
  fetch: z.array(z.string()).default([]),
  id: z.string(),
  not: z
    .object({
      /** Tools it must not call (acting when he didn't ask). */
      call: z.array(z.string()).default([]),
      /** Facts it must not state: what didn't happen, or invented. */
      contain: z.array(z.string()).default([]),
    })
    .default({ call: [], contain: [] }),
  /** What the agent did then, for whoever reads the case. */
  outcome: z.string().default(""),
});
type Case = z.infer<typeof Case>;

/** One connector call as the frozen server logged it (`mcp.call`, mcp.ts). */
interface Call {
  args?: Record<string, unknown>;
  chars?: number;
  error?: boolean;
  ids?: string[];
  tool?: string;
}

const MINUTE_MS = 60_000;
const ERROR_LINE = /^error: .*$/m;

/** Does `args` hold every `want`ed argument: a string as a case-blind part, anything else as equal JSON? */
export function holds(
  args: Record<string, unknown>,
  want: Record<string, unknown>
) {
  return Object.entries(want).every(([k, v]) =>
    typeof v === "string"
      ? String(args[k] ?? "")
          .toLowerCase()
          .includes(v.toLowerCase())
      : JSON.stringify(args[k]) === JSON.stringify(v)
  );
}

/** The code's checks of one case: each `[check, passed]`. */
export function checked(c: Case, calls: Call[]) {
  const done = calls.filter((k) => k.tool && !k.error);
  const cited = new Set(calls.flatMap((k) => k.ids ?? []));
  return [
    ...c.fetch.map((id) => [`fetch ${id}`, cited.has(id)] as const),
    ...c.call.map(
      (w) =>
        [
          `call ${w.tool} ${JSON.stringify(w.args)}`,
          done.some((k) => k.tool === w.tool && holds(k.args ?? {}, w.args)),
        ] as const
    ),
    ...c.not.call.map(
      (t) => [`no ${t}`, !done.some((k) => k.tool === t)] as const
    ),
  ];
}

/** "Tuesday 20 October 2026, 11:10 (Europe/Paris)": the time the agent is told it is. */
const stated = (iso: string) => {
  const tz = zoneAt(iso);
  const words = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: tz,
  }).format(new Date(iso));
  return `${words} (${tz})`;
};

/**
 * The ask `id` in the ledger's `lines`: when it was recorded, the ledger as the agent found it, and how it reached the agent.
 * An ask Life delivered is the event `deliver` sent, its line kept; his chat's asks are the agent's own line, written after
 * his message: the ledger before it, and his words.
 */
export function askAt(lines: string[], id: string) {
  const k = lines.findIndex((l) => parseAction(l)?.id === id);
  const ask = k < 0 ? null : parseAction(lines[k] ?? "");
  if (!ask?.instruction) {
    throw new Error(`${id} is not an ask with his words`);
  }
  const delivered = ask.madeBy !== "connector";
  return {
    at: ask.at,
    input: delivered
      ? `An ask event from Life: ${JSON.stringify(nextEvent(lines, k)?.event)}`
      : `His message in your chat: ${ask.instruction.quote}`,
    kept: lines.slice(0, delivered ? k + 1 : k),
  };
}

/** The world as it was at the ask: data, store and index in `code`'s worktree; how the ask reached the agent. */
async function freeze(c: Case, lines: string[], code: string, data: string) {
  const { at, input, kept } = askAt(lines, c.ask);
  await rm(data, { force: true, recursive: true });
  gitOut(tmpdir(), ["clone", "-q", DATA, data]);
  const commit = gitOut(data, ["rev-list", "-1", `--before=${at}`, "HEAD"]);
  if (!commit) {
    throw new Error(`~/Life has no commit before ${at}`);
  }
  gitOut(data, ["checkout", "-q", commit]);
  gitOut(data, ["remote", "remove", "origin"]);
  await Bun.write(
    join(data, "memory/actions.jsonl"),
    kept.map((l) => `${l}\n`).join("")
  );
  for (const d of ["log", "memory", "watch"]) {
    // biome-ignore lint/performance/noAwaitInLoops: three folders
    await rm(join(code, "derived", d), { force: true, recursive: true });
  }
  for (const d of ["memory", "watch"]) {
    // biome-ignore lint/performance/noAwaitInLoops: two folders
    await mkdir(join(code, "derived", d), { recursive: true });
  }
  const store = join(code, "derived/watch/lifelog.sqlite");
  const live = new Database(join(STATE, "watch/lifelog.sqlite"), {
    readonly: true,
  });
  live.run("vacuum into ?", [store]);
  live.close();
  const cut = new Database(store);
  for (const t of ["conversations", "chapters", "turns"]) {
    cut.run(`delete from ${t} where start_at > ?`, [at]);
  }
  cut.close();
  const env = {
    ...process.env,
    LIFE_DATA: data,
    LIFE_NOW: at,
    LIFE_STATE: join(code, "derived"),
  };
  const index = await exec(
    ["bun", "apps/server/src/cli.ts", "memory", "index"],
    {
      cwd: code,
      env,
    }
  );
  if (index.code !== 0) {
    throw new Error(
      `index: ${index.stderr.match(ERROR_LINE)?.[0] ?? index.stderr.trim().slice(-300)}`
    );
  }
  return { at, cut: kept.length, input };
}

/** One case, frozen, run and graded. */
async function runCase(
  c: Case,
  o: {
    code: string;
    data: string;
    engine: Engine;
    lines: string[];
    run: string;
  }
) {
  const started = performance.now();
  const world = await freeze(c, o.lines, o.code, o.data);
  // Kept, like an eval's: what the agent and the judge read and answered.
  const dir = join(OUT, "bench-agent", o.run, c.id);
  const answer = (await askOnce({
    context: { now: stated(world.at) },
    dir: join(dir, "agent"),
    input: world.input,
    llm: llmFor("main", o.engine),
    prompt: "agent-bench.v1",
    run: o.run,
    tools: {
      // Its worktree's code, and the .env there (lifelog's token).
      command: ["bun", "--cwd", o.code, "scripts/bench-agent.ts", "--serve"],
      env: {
        LIFE_DATA: o.data,
        LIFE_NOW: world.at,
        LIFE_STATE: join(o.code, "derived"),
      },
    },
  })) as { reply?: string };
  const calls = (
    await recentEvents<Call>(1000, "mcp.call", join(o.code, "derived/log"))
  ).filter((k) => k.tool);
  const checks: (readonly [string, boolean])[] = checked(c, calls);
  const facts = [
    ...c.contain.map((fact, i) => ({ fact, id: `c${i}`, true: true })),
    ...c.not.contain.map((fact, i) => ({ fact, id: `n${i}`, true: false })),
  ];
  if (facts.length > 0) {
    // What it said: its reply, the reminders it would have set, and its notes on the task.
    const said = [
      { id: "reply", text: answer.reply ?? "" },
      ...calls
        .filter((k) => k.tool === "reminders")
        .map((k, i) => ({ id: `reminder${i}`, text: JSON.stringify(k.args) })),
      ...linesOf(join(o.data, "memory/actions.jsonl"))
        .slice(world.cut)
        .map((l, i) => ({
          id: `task${i}`,
          text: JSON.stringify(parseAction(l)?.after),
        })),
    ].map((s) => ({ ...s, date: localDate(world.at) }));
    const { marks } = tally(
      facts,
      await judge(facts, said, {
        dir: join(dir, "judge"),
        engine: o.engine,
        run: o.run,
      })
    );
    checks.push(
      ...facts.map(
        (f) =>
          [
            `${f.true ? "says" : "never says"} ${f.fact}`,
            marks.get(f.id) === "ok",
          ] as const
      )
    );
  }
  return {
    calls: calls.length,
    chars: calls.reduce((n, k) => n + (k.chars ?? 0), 0),
    checks,
    id: c.id,
    minutes: Math.round((performance.now() - started) / MINUTE_MS),
  };
}

type Row = Awaited<ReturnType<typeof runCase>> | { error: string; id: string };

export function table(rows: Row[], about: string) {
  const passed = (r: Row) =>
    "checks" in r ? r.checks.filter(([, ok]) => ok).length : 0;
  const total = rows.reduce(
    (n, r) => n + ("checks" in r ? r.checks.length : 0),
    0
  );
  return [
    `# The agent bench (${about})`,
    "",
    `${rows.reduce((n, r) => n + passed(r), 0)}/${total} checks passed.`,
    "",
    "| case | checks | tool calls | characters read | time | failed |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) =>
      "checks" in r
        ? `| ${r.id} | ${passed(r)}/${r.checks.length} | ${r.calls} | ${r.chars} | ${r.minutes} min | ${r.checks
            .filter(([, ok]) => !ok)
            .map(([check]) => check.replaceAll("|", "/"))
            .join("; ")} |`
        : `| ${r.id} | error |||| ${r.error.replaceAll("|", "/").replaceAll("\n", " ").slice(0, 200)} |`
    ),
  ].join("\n");
}

async function bench(file: string, only: string[], engine: Engine) {
  const cases = z
    .object({ cases: z.array(Case) })
    .parse(await Bun.file(file).json())
    .cases.filter((c) => only.length === 0 || only.includes(c.id));
  await spareQuota(engine);
  const tmp = await mkdtemp(join(tmpdir(), "life-bench-agent-"));
  const code = join(tmp, "code");
  // A metered run: what the agent's calls spent of his Codex plan is in its `use`.
  const rec = await metered("bench.agent", { cases: cases.length, engine });
  const { run } = rec;
  const lines = linesOf(ACTIONS);
  try {
    await ended(rec, async () => {
      await checkout(code, ["node_modules", ".env"], ["settings.json"]);
      const rows: Row[] = [];
      for (const c of cases) {
        // One at a time: the cases share the worktree's derived/.
        // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose
        const row = await runCase(c, {
          code,
          data: join(tmp, "data"),
          engine,
          lines,
          run,
        }).catch((e: Error) => ({ error: e.message, id: c.id }));
        rows.push(row);
        console.error(`${c.id}: ${"checks" in row ? "done" : row.error}`);
      }
      const head = gitOut(ROOT, ["rev-parse", "--short", "HEAD"]);
      const what =
        engine === "codex"
          ? "Codex, as the agent"
          : `${engine}: a harness check, not the agent's result`;
      console.log(table(rows, `${run}, ${what}, code ${head}`));
      return { cases: rows.length };
    });
  } finally {
    git(ROOT, ["worktree", "remove", "--force", code]);
    await rm(tmp, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    options: {
      engine: { type: "string" },
      only: { type: "string" },
      serve: { type: "boolean" },
    },
  });
  if (values.serve) {
    if (FROZEN === undefined) {
      throw new Error("--serve is the bench's frozen connector: LIFE_NOW only");
    }
    await buildServer().connect(new StdioServerTransport());
  } else {
    await bench(
      positionals[0] ?? CASES,
      values.only?.split(",") ?? [],
      Engine.parse(values.engine ?? "codex")
    );
  }
}
