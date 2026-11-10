// `bun scripts/question-cases.ts [--only id,…] [--run]`: his question cases, each asked to a headless agent whose
// only tools are Life's connector, reads only, and its reply checked for what it must hold and must not say
// (docs/operations.md, "Measuring"). The memory under test is his own, as it stands. Without `--run` it only counts
// the cases. Prints counts, never a question or a reply; `--serve` is the connector over stdio, for the agent.

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readJson, writeJson } from "@life/server/src/core/files";
import { recentEvents } from "@life/server/src/core/log";
import { LIFE_CODE_DIR, OWNER_DATA_DIR } from "@life/server/src/core/paths";
import { buildServer } from "@life/server/src/host/http/mcp";
import { INDEX, OUT } from "@life/server/src/memory/ledger";
import { ended, metered } from "@life/server/src/memory/run";
import { spareQuota } from "@life/server/src/memory/schedule";
import { judge, tally } from "@life/server/src/memory/tally";
import { dayNow } from "@life/server/src/memory/zones";
import { askOnce, llmFor } from "@life/server/src/models/llm";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { linkState } from "./bench";

/** His question cases, and where each run's results go: his data, never this repo. */
const CASES = join(OWNER_DATA_DIR, "docs/evals/question-cases.json");
const RESULTS = join(OWNER_DATA_DIR, "docs/evals/question-cases");
/** The agent that answers: Codex's main tier, the closest to his own agents (his word, 10 Nov 2026). */
const AGENT = "codex";
const PROMPT = "question-case.v1";
/** What the connector's child shares of this process's state: its settings, the voice store and the search index. */
const STATE = ["settings.json", "watch", "memory"];

/**
 * A question case: one of his questions, as he asked it, with what a right reply holds and what it must not say. Its
 * id starts with the letter of its kind in his question set (A where things stand, B practical, C a relationship, D
 * an arc, E a prediction, F himself). `asker`: his own question, or one mined from his chats.
 */
const Case = z
  .object({
    asker: z.enum(["owner", "mined"]),
    contain: z.array(z.string().min(1)).min(1),
    id: z.string().regex(/^[A-F][\w-]*$/),
    not: z
      .object({ contain: z.array(z.string().min(1)).default([]) })
      .strict()
      .default({ contain: [] }),
    question: z.string().min(1),
  })
  .strict();
type Case = z.infer<typeof Case>;
const Cases = z.object({ about: z.string(), cases: z.array(Case) }).strict();
const Reply = z.object({ reply: z.string() });
/** One call the agent made to the connector, as its `mcp.call` line says: the tool and how much it returned. */
interface ToolCall {
  chars?: number;
  tool?: string;
}

/** The cases of `file`, those of `only` when given. */
export function casesOf(file: unknown, only: string[] = []) {
  const { cases } = Cases.parse(file);
  return only.length > 0 ? cases.filter((c) => only.includes(c.id)) : cases;
}

/**
 * One case asked and checked: the agent's reply, then the judge on what it holds (`contain`, true facts) and must
 * not say (`not.contain`, false ones), the reply as the one claim. It passes when every point's mark is ok.
 */
export async function runCase(
  c: Case,
  o: {
    ask: (c: Case, dir: string) => Promise<unknown>;
    dir: string;
    grade: typeof judge;
    run: string;
    today: string;
  }
) {
  const started = performance.now();
  const { reply } = Reply.parse(await o.ask(c, join(o.dir, "agent")));
  const facts = [
    ...c.contain.map((fact, i) => ({ fact, id: `c${i}`, true: true })),
    ...c.not.contain.map((fact, i) => ({ fact, id: `n${i}`, true: false })),
  ];
  const grades = await o.grade(
    facts,
    [{ date: o.today, id: "reply", text: reply }],
    { dir: join(o.dir, "judge"), run: o.run }
  );
  const { marks } = tally(facts, grades);
  const points = facts.map((f) => ({ ...f, mark: marks.get(f.id) }));
  return {
    id: c.id,
    ms: Math.round(performance.now() - started),
    passed: points.every((p) => p.mark === "ok"),
    points,
    reply,
  };
}

/**
 * How the cases did, as counts: by kind (the id's letter) and asker, passed of asked. A case not run has neither
 * `passed` nor `error`; one that failed to run is asked and not passed. Nothing of his.
 */
export function countsOf(
  rows: {
    asker: Case["asker"];
    error?: string;
    id: string;
    passed?: boolean;
  }[]
) {
  return [...Map.groupBy(rows, (r) => `${r.id[0]} ${r.asker}`)]
    .map(([key, list]) => ({
      asked: list.filter((r) => r.passed !== undefined || r.error).length,
      cases: list.length,
      key,
      passed: list.filter((r) => r.passed).length,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The agent's call for one case: Codex with the connector as its only tools, served by this script over stdio from a
 * state dir of its own (`linkState`): his settings, voice store and index by links, its own log. So no call of the
 * bench lands in his Life's log, and what it read is counted per case.
 */
async function askAgent(c: Case, dir: string, run: string) {
  const state = await mkdtemp(join(tmpdir(), "life-question-"));
  try {
    await linkState(state, STATE);
    const reply = await askOnce({
      dir,
      input: { question: c.question },
      llm: llmFor("main", AGENT),
      prompt: PROMPT,
      run,
      tools: {
        command: [
          "bun",
          "--cwd",
          LIFE_CODE_DIR,
          "scripts/question-cases.ts",
          "--serve",
        ],
        env: { LIFE_OWNER_DATA_DIR: OWNER_DATA_DIR, LIFE_STATE_DIR: state },
      },
    });
    const calls = await recentEvents<ToolCall>(
      2,
      "mcp.call",
      join(state, "log")
    );
    return { calls, reply };
  } finally {
    await rm(state, { force: true, recursive: true });
  }
}

type Row = (
  | Awaited<ReturnType<typeof runCase>>
  | { error: string; id: string }
) & { asker: Case["asker"]; chars: number; tools: string[] };
const isPassed = (r: Row) => "passed" in r && r.passed;

/**
 * Every case in order, each asked and checked, each row handed to `keep` as soon as it is done. A case that fails is
 * its row, never the end of the run; the Codex reserve, read before each case, ends it, after what was paid is kept.
 */
async function runAll(
  cases: Case[],
  run: string,
  dir: string,
  keep: (rows: Row[]) => void
) {
  const rows: Row[] = [];
  for (const c of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: cases run in order
    await spareQuota(AGENT);
    let calls: ToolCall[] = [];
    // biome-ignore lint/performance/noAwaitInLoops: cases run in order
    const row = await runCase(c, {
      ask: async (x, d) => {
        const asked = await askAgent(x, d, run);
        ({ calls } = asked);
        return asked.reply;
      },
      dir: join(dir, c.id),
      grade: judge,
      run,
      today: dayNow(),
    }).catch((e: Error) => ({ error: e.message, id: c.id }));
    rows.push({
      ...row,
      asker: c.asker,
      chars: calls.reduce((n, k) => n + (k.chars ?? 0), 0),
      tools: calls.flatMap((k) => (k.tool ? [k.tool] : [])),
    });
    keep(rows);
  }
  return rows;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      run: { type: "boolean" },
      serve: { type: "boolean" },
    },
  });
  if (values.serve) {
    await buildServer(true).connect(new StdioServerTransport());
  } else if (values.run) {
    const cases = casesOf(readJson(CASES), values.only?.split(","));
    // Nothing to ask, or no memory to ask it of (a checkout with no search index): refused before any spend.
    if (cases.length === 0 || !existsSync(INDEX)) {
      throw new Error(
        cases.length === 0
          ? "no question case matches --only"
          : `no search index at ${INDEX}: run from the checkout Life runs from`
      );
    }
    const rec = await metered("eval", { cases: cases.length }, AGENT);
    let rows: Row[] = [];
    // His words (questions, replies, points) go to his data only: the run's log line holds counts.
    await ended(rec, async () => {
      rows = await runAll(cases, rec.run, join(OUT, "evals", rec.run), (r) =>
        writeJson(join(RESULTS, `${rec.run}.json`), { cases: r })
      );
      return { cases: rows.length, passed: rows.filter(isPassed).length };
    });
    console.table(countsOf(rows));
  } else {
    console.table(countsOf(casesOf(readJson(CASES), values.only?.split(","))));
  }
}
