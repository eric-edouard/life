// What every model step shares: run one headless call, getting back its JSON reply, with no tools: on the owner's
// engine (`claude -p` or `codex exec` on his subscriptions, or an API router: OpenRouter, allmodels); and how full his Codex quota is.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { log } from "../core/log";
import { Engine } from "../core/names";
import { isHis, LIFE_CODE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { CODEX, cliEnv, MACHINE_DIR } from "../core/platform";
import { exec, firstLine } from "../core/proc";
import { settings } from "../core/settings";
import {
  type Answer,
  add,
  extractJson,
  imageBlock,
  type Llm,
  MODEL_TIMEOUT_MS,
  type ModelCall,
  NONE,
  type Tier,
  type Tokens,
} from "./model-call";
import { askRoutes, ROUTERS, type Router, routesOf } from "./routers";

const CLAUDE_MODELS: Record<Tier, string> = {
  deep: "opus",
  fast: "haiku",
  main: "sonnet",
};
// Same model as lifelog. Older codex clients reject it, and this Mac has several (an
// nvm global, a broken /usr/local one, the app's bundled one), so Life runs the version pinned in package.json, natively
// (launchd has no node).
const SOL: Record<Tier, string> = {
  deep: "gpt-6.1-sol",
  fast: "gpt-6.1-sol",
  main: "gpt-6.1-sol",
};
const CODEX_BIN = join(LIFE_CODE_DIR, CODEX);
// Codex always loads AGENTS.md from its home, and no flag turns that off, so Life has its own home with a login of
// its own (`CODEX_HOME=<this> codex login --device-auth`, once) and no instruction files. The repo's own AGENTS.md is
// kept out by running in an empty temp folder and `project_doc_max_bytes=0`; `skills.include_instructions=false` drops
// the skills catalog.
const CODEX_HOME = join(MACHINE_DIR, "codex");
/** Codex's reasoning effort by tier. */
const CODEX_EFFORT: Record<Tier, string> = {
  deep: "high",
  fast: "low",
  main: "medium",
};
// Everything codex could call besides the model itself: recorded speech gets no tools, plugins or memory.
const CODEX_TOOLS = ["shell_tool", "unified_exec", "code_mode_host"];
const CODEX_OFF =
  "plugins apps browser_use browser_use_external computer_use image_generation multi_agent hooks goals in_app_browser skill_search tool_suggest memories".split(
    " "
  );

/** The engine he chose (a test run reads its own settings: claude, so no test reaches Codex). */
export const readEngine = (): Engine => settings().engine;

/**
 * `LIFE_LLM=engine/model[/effort]`: one process's model for every tier, set by the bench for a candidate and for its
 * judge (`scripts/bench.ts`), never by launchd. Refused on his own data: what is written there comes from his engine.
 */
export function llmOverride(
  set = process.env.LIFE_LLM,
  data = OWNER_DATA_DIR
): Llm | undefined {
  if (!set) {
    return;
  }
  if (isHis(data)) {
    throw new Error(
      "LIFE_LLM is for a copy of the data (LIFE_OWNER_DATA_DIR), never ~/Life"
    );
  }
  const [engine = "", ...rest] = set.split("/");
  const effort = EFFORTS.includes(rest.at(-1) ?? "") ? rest.pop() : undefined;
  if (rest.length === 0) {
    throw new Error(`LIFE_LLM is engine/model[/effort], not ${set}`);
  }
  return { effort, engine: Engine.parse(engine), model: rest.join("/") };
}

/** An `Llm` as `LIFE_LLM` names it, `engine/model[/effort]`: for `LIFE_LLM`, the log and the nightly email. */
export const llmSpec = (l: Llm) =>
  [l.engine, l.model, l.effort].filter(Boolean).join("/");

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * allmodels' model for every tier, his choice of 28 Oct 2026: DeepSeek V4.1 Flash 1017 abliterated, on the hosts after
 * `@` in his order (`model@host,host`), Refuseless first, Hopper when it fails. Both say they keep no prompts or
 * outputs and both take images (the files step sends them). Experiential Labs, also on allmodels, is left out: it
 * records prompts and responses for 30 days by default (its privacy policy, 16 Sep 2026).
 */
const DEEPSEEK_FLASH =
  "deepseek/deepseek-v4.1-flash-abliterated@refuseless,hopper";
const ALLMODELS_MODELS: Record<Tier, string> = {
  deep: DEEPSEEK_FLASH,
  fast: DEEPSEEK_FLASH,
  main: DEEPSEEK_FLASH,
};
/**
 * OpenRouter's model for every tier, his choice of 8 Nov 2026: the same model, not abliterated, about half the price, on
 * fp8 hosts OpenRouter lists as keeping no data, thinking at medium; then allmodels' abliterated one at high, for what
 * they refuse or fail.
 */
const DEEPSEEK_FLASH_ROUTED = `openrouter:deepseek/deepseek-v4.1-flash-1017@deepinfra/fp8,morph/fp8=medium allmodels:${DEEPSEEK_FLASH}=high`;
const OPENROUTER_MODELS: Record<Tier, string> = {
  deep: DEEPSEEK_FLASH_ROUTED,
  fast: DEEPSEEK_FLASH_ROUTED,
  main: DEEPSEEK_FLASH_ROUTED,
};
/**
 * allmodels' effort by tier: both hosts take only none, low, high and max (Hopper xhigh too) and refuse "medium"
 * (checked 28 Oct 2026), so the pages think at high. Hopper thinks more at high than at low; Refuseless a little more,
 * and it thinks even at none. Episodes and extract think at low: on the truth days it held as many true facts, matched
 * more episodes and spent 16% fewer tokens than high (bench of 5 Nov 2026, his OK).
 */
const ALLMODELS_EFFORT: Record<Tier, string> = {
  deep: "low",
  fast: "low",
  main: "high",
};

/** Read once at the start of a run, so the engine cannot change halfway through it. */
export function llmFor(tier: Tier, engine = readEngine()): Llm {
  const p = PROVIDERS[engine];
  return (
    llmOverride() ?? { effort: p.effort?.[tier], engine, model: p.models[tier] }
  );
}

/** Recorded on everything a model made; the engine stays out of the cache key, so switching engines re-runs nothing. */
export const stamp = (llm: Llm, prompt: string, run: string) => ({
  engine: llm.engine,
  model: llm.model,
  prompt,
  run,
});

const ClaudeResult = z.object({
  is_error: z.boolean(),
  num_turns: z.number().optional(),
  result: z.string().default(""),
  total_cost_usd: z.number().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
});

const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** codex's `--json` events: the tokens of each `turn.completed`, summed. */
export function codexTokens(jsonl: string): Tokens {
  return jsonl
    .split("\n")
    .flatMap((l) => {
      try {
        const e = JSON.parse(l);
        return e?.type === "turn.completed" ? [e.usage ?? {}] : [];
      } catch {
        return [];
      }
    })
    .reduce(
      (t, u) =>
        add(t, {
          cached: num(u.cached_input_tokens),
          input: num(u.input_tokens),
          output: num(u.output_tokens),
        }),
      NONE
    );
}

/** claude's usage: input counts cache reads and writes too, as codex's does. */
export const claudeTokens = (u: Record<string, unknown> = {}): Tokens => ({
  cached: num(u.cache_read_input_tokens),
  input:
    num(u.input_tokens) +
    num(u.cache_read_input_tokens) +
    num(u.cache_creation_input_tokens),
  output: num(u.output_tokens),
});

// A TOML basic string for `-c key=value`; JSON's escapes are TOML's, bar a raw DEL.
const toml = (s: string) => JSON.stringify(s).replaceAll("\u007f", "");

const promptText = (prompt: string) =>
  Bun.file(join(LIFE_CODE_DIR, "prompts", `${prompt}.md`)).text();

/** Only what a CLI needs to run: no API key (bill the subscriptions) and none of Life's .env secrets. */
const modelEnv = (extra: Record<string, string> = {}) => ({
  ...cliEnv(),
  ...extra,
});

/**
 * A CLI run to its end in an empty folder outside the repo (inside it, claude loads the project's auto-memory and
 * codex its AGENTS.md: recorded content must reach the model with nothing but the prompt). Throws on a failure.
 */
async function cli(
  name: string,
  args: (cwd: string) => string[],
  o: { env: Record<string, string>; stdin: string }
) {
  const cwd = await mkdtemp(join(tmpdir(), "life-llm-"));
  const { code, killed, stderr, stdout } = await exec(args(cwd), {
    cwd,
    env: o.env,
    stdin: o.stdin,
    timeout: MODEL_TIMEOUT_MS,
  }).finally(() => rm(cwd, { force: true, recursive: true }));
  if (code !== 0) {
    // claude reports its errors on stdout, codex on stderr: keep the tail of both.
    const detail = [stderr, stdout]
      .map((t) => t.trim().slice(-300))
      .filter(Boolean)
      .join(" | ");
    throw new Error(
      `${name} ${killed ? `timed out after ${MODEL_TIMEOUT_MS / 1000} s` : `exited ${code}`}: ${detail}`
    );
  }
  return stdout;
}

async function askClaude({ dir, images, input, llm, system }: ModelCall) {
  const stdout = await cli(
    "claude",
    () => [
      ...["claude", "-p", "--model", llm.model, "--verbose"],
      ...(llm.effort ? ["--effort", llm.effort] : []),
      ...["--input-format", "stream-json", "--output-format", "stream-json"],
      ...["--tools", "", "--strict-mcp-config", "--setting-sources", ""],
      ...["--no-session-persistence", "--system-prompt", system],
    ],
    {
      env: modelEnv(),
      stdin: JSON.stringify({
        message: {
          content: [
            { text: JSON.stringify(input), type: "text" },
            ...(await Promise.all(images.map(imageBlock))),
          ],
          role: "user",
        },
        type: "user",
      }),
    }
  );
  await Bun.write(join(dir, "claude.jsonl"), stdout);
  // A stream of events, the result last.
  const res = ClaudeResult.parse(
    JSON.parse(stdout.trim().split("\n").at(-1) ?? "")
  );
  const fields = {
    costUsd: res.total_cost_usd,
    tokens: claudeTokens(res.usage),
    turns: res.num_turns,
    usage: res.usage,
  };
  return {
    fields,
    refusal: res.is_error
      ? `claude reported an error: ${res.result.slice(-300)}`
      : undefined,
    text: res.result,
  };
}

async function askCodex({ dir, images, input, llm, system }: ModelCall) {
  if (!(await Bun.file(join(CODEX_HOME, "auth.json")).exists())) {
    // codex refuses a CODEX_HOME that doesn't exist, even to log in.
    await mkdir(CODEX_HOME, { recursive: true });
    throw new Error(
      `codex has no login in ${CODEX_HOME}: run CODEX_HOME="${CODEX_HOME}" codex login --device-auth`
    );
  }
  const reply = join(dir, "codex.txt");
  const events = await cli(
    "codex",
    (cwd) => [
      // The pinned binary, read-only, and none of the extras (CODEX_OFF).
      ...[CODEX_BIN, "exec", "--skip-git-repo-check", "-s", "read-only"],
      ...["-C", cwd, "-m", llm.model],
      ...CODEX_OFF.flatMap((f) => ["--disable", f]),
      ...["-", "--ephemeral", "--ignore-user-config", "--ignore-rules"],
      ...[
        `model_reasoning_effort=${toml(llm.effort ?? "medium")}`,
        `developer_instructions=${toml(system)}`,
        "project_doc_max_bytes=0",
        'web_search="disabled"',
        "skills.bundled.enabled=false",
        "skills.include_instructions=false",
      ].flatMap((c) => ["-c", c]),
      ...CODEX_TOOLS.flatMap((f) => ["--disable", f]),
      ...["--json", "-o", reply],
      ...images.map((i) => `--image=${i}`),
    ],
    { env: modelEnv({ CODEX_HOME }), stdin: JSON.stringify(input) }
  );
  return {
    fields: { tokens: codexTokens(events) },
    text: await Bun.file(reply).text(),
  };
}

/** How full his Codex plan is: its fuller window (on his plan, the week) and when that window resets. */
export interface Quota {
  resetsAt: string | null;
  used: number;
}
const RateWindow = z.object({
  resetsAt: z.number().nullish(),
  usedPercent: z.number(),
});
const RateLimits = z.object({
  result: z.object({
    rateLimits: z.object({
      primary: RateWindow.nullish(),
      secondary: RateWindow.nullish(),
    }),
  }),
});
// The app-server's JSON-RPC (`codex app-server generate-json-schema`): initialized first, then the one read.
const READ_LIMITS = `{"id":1,"method":"initialize","params":{"clientInfo":{"name":"life","version":"1"}}}
{"method":"initialized"}
{"id":2,"method":"account/rateLimits/read"}
`;

/** The quota in the app-server's answer to `account/rateLimits/read`; undefined for no window or no answer. */
export function quotaOf(reply = ""): Quota | undefined {
  try {
    const { primary, secondary } = RateLimits.parse(JSON.parse(reply)).result
      .rateLimits;
    const [w] = [primary, secondary]
      .flatMap((x) => (x ? [x] : []))
      .sort((a, b) => b.usedPercent - a.usedPercent);
    return (
      w && {
        resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
        used: w.usedPercent,
      }
    );
  } catch {
    // No answer, or not this one: unread.
  }
}

/**
 * His Codex plan's usage, read from Codex's app-server (no model call, no quota spent) and logged, unread too, so the
 * last line is the last reading: undefined when this process's calls (on `engine`, his setting unless a bench says) don't go to Codex, Codex doesn't answer, or the
 * engine setting is corrupt (the night's own calls fail on it, loudly). Never throws.
 */
export async function quota(engine?: Engine) {
  if (!hasQuota(engine)) {
    return;
  }
  let q: Quota | undefined;
  try {
    q = await PROVIDERS[llmFor("main", engine).engine].quota?.();
  } catch {
    // Unread.
  }
  log("quota.read", { ...q });
  return q;
}

/** His Codex plan's usage, from Codex's app-server. */
const codexQuota = async () =>
  quotaOf(
    await firstLine(
      [CODEX_BIN, "app-server"],
      READ_LIMITS,
      (l) => JSON.parse(l).id === 2,
      { env: modelEnv({ CODEX_HOME }), timeout: 15_000 }
    )
  );

/**
 * Every model provider, one entry each: its models by tier, its effort, its call, its key's name when it takes one,
 * and how full its quota is when it has one.
 */
interface Provider {
  ask: (call: ModelCall) => Promise<Answer>;
  effort?: Record<Tier, string>;
  /** Where its calls go first: `isOnline` asks it. */
  host: string;
  /** The keys it takes, one per router of its routes. */
  keys: string[];
  models: Record<Tier, string>;
  quota?: () => Promise<Quota | undefined>;
}
/** An API engine: its calls go through its routes, which name its host and keys. */
function apiEngine(
  engine: Router,
  models: Record<Tier, string>,
  effort?: Record<Tier, string>
): Provider {
  const routers = [
    ...new Set(
      Object.values(models).flatMap((m) =>
        routesOf(m, engine).map((r) => r.router)
      )
    ),
  ];
  return {
    ask: askRoutes,
    effort,
    host: new URL(ROUTERS[routers[0] ?? engine].url).host,
    keys: routers.map((r) => ROUTERS[r].key),
    models,
  };
}
const PROVIDERS: Record<Engine, Provider> = {
  allmodels: apiEngine("allmodels", ALLMODELS_MODELS, ALLMODELS_EFFORT),
  claude: {
    ask: askClaude,
    host: "api.anthropic.com",
    keys: [],
    models: CLAUDE_MODELS,
  },
  codex: {
    ask: askCodex,
    effort: CODEX_EFFORT,
    host: "chatgpt.com",
    keys: [],
    models: SOL,
    quota: codexQuota,
  },
  openrouter: apiEngine("openrouter", OPENROUTER_MODELS),
};

/**
 * Whether Life is online: his main engine's provider answers at all (any HTTP status) within 5 s. Offline (travelling,
 * a VPN down) nothing Life schedules can work. The request carries no key and no text.
 */
export const isOnline = () =>
  fetch(`https://${PROVIDERS[llmFor("main").engine].host}`, {
    method: "HEAD",
    signal: AbortSignal.timeout(5000),
  }).then(
    () => true,
    () => false
  );

/** The keys each engine takes, by engine: the app asks for each by this name. */
export const engineKeys = () =>
  Object.fromEntries(Object.entries(PROVIDERS).map(([e, p]) => [e, p.keys]));

/**
 * Whether this process's calls (on `engine`, his setting unless a bench says) go to an engine with a quota to read (his
 * Codex plan); `quota` and `metered` read one only then. The others count only tokens.
 */
export const hasQuota = (engine?: Engine) =>
  PROVIDERS[llmFor("main", engine).engine].quota !== undefined;

/**
 * One shot with no tools, no other MCP servers and no CLAUDE.md: `prompts/<prompt>.md` is the whole system prompt and
 * `input` (as JSON) the whole user message. Code assembles everything the model sees, so the call stays small.
 * `context` (as JSON) is appended to the system prompt: the same for every call of a run, so it is cached.
 * The input and the reply are kept in `dir`, so anything made from a call can be checked against exactly what the
 * model read. `images` (JPEG or PNG paths) follow the input, in order. Returns the reply's JSON; every call, failed or
 * not, is one `model.run` line.
 */
export async function askOnce(opts: {
  context?: unknown;
  dir: string;
  images?: string[];
  input: unknown;
  llm: Llm;
  prompt: string;
  run: string;
}) {
  const { dir, llm } = opts;
  const context =
    opts.context === undefined
      ? ""
      : `\n\n<context>\n${JSON.stringify(opts.context)}\n</context>\n`;
  const system = `${await promptText(opts.prompt)}${context}`;
  const made = { ...stamp(llm, opts.prompt, opts.run), effort: llm.effort };
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "input.json"), JSON.stringify(opts.input, null, 1));
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  let fields: Answer["fields"];
  try {
    const answer = await PROVIDERS[llm.engine].ask({
      dir,
      images: opts.images ?? [],
      input: opts.input,
      llm,
      system,
    });
    ({ fields } = answer);
    if (answer.refusal) {
      throw new Error(answer.refusal);
    }
    const json = extractJson(answer.text);
    log("model.run", { ...made, ...fields, ms: ms(), ok: true });
    return json;
  } catch (e) {
    log("model.run", {
      ...made,
      ...fields,
      error: (e as Error).message,
      ms: ms(),
      ok: false,
    });
    throw e;
  }
}
