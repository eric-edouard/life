// What every model step shares: run one headless call, getting back its JSON reply, with no tools: on the owner's
// engine (`claude -p` or `codex exec` on his subscriptions, or an API router: OpenRouter, allmodels); and how full his Codex quota is.
// The one call with tools is the question cases' agent (scripts/question-cases.ts): Codex, given Life's connector,
// reads only, and nothing else (his word, 10 Nov 2026).
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { log } from "../core/log";
import { errorOf, fromModel } from "../core/log-line";
import { Engine } from "../core/names";
import { LIFE_CODE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { CODEX, cliEnv, isOwnLife, MACHINE_DIR } from "../core/platform";
import { exec, firstLine, readProgram } from "../core/proc";
import { settings } from "../core/settings";
import type { IntegrationTerms } from "../records/integration";
import {
  type Answer,
  add,
  type CallReads,
  extractJson,
  imageBlock,
  type Llm,
  MODEL_TIMEOUT_MS,
  type ModelCall,
  NONE,
  type Tier,
  type Tokens,
  type Tools,
} from "./model-call";
import { promptNameOf, promptText } from "./prompt-parts";
import {
  askRoutes,
  MAX_TOKENS,
  ROUTERS,
  type Router,
  routesOf,
} from "./routers";

const CLAUDE_MODELS: Record<Tier, string> = {
  deep: "opus",
  fast: "haiku",
  judge: "sonnet",
  main: "sonnet",
};
// Same model as the voice server. Older codex clients reject it, and this Mac has several (an
// nvm global, a broken /usr/local one, the app's bundled one), so Life runs the version pinned in package.json, natively
// (launchd has no node).
const SOL: Record<Tier, string> = {
  deep: "gpt-6.1-sol",
  fast: "gpt-6.1-sol",
  judge: "gpt-6.1-sol",
  main: "gpt-6.1-sol",
};
const CODEX_BIN = join(LIFE_CODE_DIR, CODEX);
// Codex always loads AGENTS.md from its home, and no flag turns that off, so Life has its own home with a login of
// its own (`CODEX_HOME=<this> codex login --device-auth`, once) and no instruction files. The repo's own AGENTS.md is
// kept out by running in an empty temp folder and `project_doc_max_bytes=0`; `skills.include_instructions=false` drops
// the skills catalog.
export const CODEX_HOME = join(MACHINE_DIR, "codex");
/** Codex's reasoning effort by tier. */
const CODEX_EFFORT: Record<Tier, string> = {
  deep: "high",
  fast: "low",
  judge: "medium",
  main: "medium",
};
// Everything codex could call besides the model itself: recorded speech gets no tools, plugins or memory.
const CODEX_TOOLS = ["shell_tool", "unified_exec", "code_mode_host"];
// The question cases' agent reaches MCP tools only through code mode's `exec` (a V8 isolate with no file system or
// network), so it keeps that and still has no shell; `apply_patch`, nested there, meets the read-only sandbox. Its
// nested `clock__curr_time` reads the real time, which is the time its questions are asked at (verified 21 Oct 2026 on
// codex 0.162.1 against a fake provider, no quota spent).
export const CODEX_AGENT_OFF = ["shell_tool", "unified_exec", "sleep_tool"];
/** The name a call's one MCP server goes by. */
const SERVER = "life";
export const CODEX_OFF =
  "plugins apps browser_use browser_use_external computer_use image_generation multi_agent hooks goals in_app_browser skill_search tool_suggest memories".split(
    " "
  );

/**
 * The engine he chose at `init`; a Life set up before `init --engine` keeps the old default, claude (a test run's
 * settings name claude, so no test reaches Codex).
 */
export const readEngine = ({ engine } = settings()): Engine =>
  engine ?? "claude";

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
  if (isOwnLife(data)) {
    throw new Error(
      "LIFE_LLM is for a copy of the data (LIFE_OWNER_DATA_DIR), never his own"
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
/**
 * Its effort by route: both hosts take only none, low, high and max (Hopper xhigh too) and refuse "medium" (checked 28
 * Oct 2026), so the pages think at high. Episodes and extract think at low: on the truth days it held as many true
 * facts, matched more episodes and spent 16% fewer tokens than high (bench of 5 Nov 2026, his OK).
 */
const ALLMODELS_MODELS: Record<Tier, string> = {
  deep: `${DEEPSEEK_FLASH}=low`,
  fast: `${DEEPSEEK_FLASH}=low`,
  judge: `${DEEPSEEK_FLASH}=high`,
  main: `${DEEPSEEK_FLASH}=high`,
};
/**
 * OpenRouter's model for every tier, his choice of 8 Nov 2026: the same model, not abliterated, about half the price, on
 * fp8 hosts OpenRouter lists as keeping no data; then allmodels' abliterated one at high, for what they refuse or fail.
 * Episodes and extraction (the deep tier) think at low (his choice of 14 Nov 2026, after a bench of 6 low runs against
 * 3 high: as many true facts held, about half as many wrong facts, about 3 fewer episodes found of 61, about 10% fewer
 * tokens). The fast tier thinks at medium, the working main tier (pages, personas, the exchange reads) at high, and the
 * judge tier at high because it is the yardstick: the stored baselines were graded at high and it moves only on purpose.
 */
const routed = (effort: string) =>
  `openrouter:deepseek/deepseek-v4.1-flash-1017@deepinfra/fp8,morph/fp8=${effort} allmodels:${DEEPSEEK_FLASH}=high`;
const OPENROUTER_MODELS: Record<Tier, string> = {
  deep: routed("low"),
  fast: routed("medium"),
  judge: routed("high"),
  main: routed("high"),
};

/**
 * What a turn that answers him thinks at on the agents' one model (the main session's ask; the delivery gate's call):
 * lower than a background turn's (`piRouteOf().effort`), so his answer comes fast (the v4 plan, bundle C).
 */
export const ASK_EFFORT = "low";

/**
 * What the desk's pi agents run on (the owner's decisions of 22 Nov 2026, `docs/plans/pi-runtime.md`): the memory's
 * main-tier OpenRouter route, its model, its hosts and its effort, so agents and memory share one model on the same
 * hosts that keep nothing.
 */
export function piRouteOf() {
  const routes = routesOf(OPENROUTER_MODELS.main, "openrouter").filter(
    (r) => r.router === "openrouter"
  );
  const [first] = routes;
  if (!first) {
    throw new Error("the OpenRouter engine names no OpenRouter host");
  }
  return {
    contextTokens: PROVIDERS.openrouter.contextTokens,
    effort: first.effort,
    hosts: routes.map((r) => r.host),
    model: first.model,
  };
}

/** Read once at the start of a run, so the engine cannot change halfway through it. */
export function llmFor(tier: Tier, engine = readEngine()): Llm {
  const p = PROVIDERS[engine];
  return (
    llmOverride() ?? { effort: p.effort?.[tier], engine, model: p.models[tier] }
  );
}

/** Recorded on everything a model made; the engine stays out of the cache key, so switching engines re-runs nothing. */
export const stamp = (
  llm: Llm,
  prompt: string,
  run: string,
  on: readonly string[] = []
) => ({
  engine: llm.engine,
  model: llm.model,
  prompt: promptNameOf(prompt, on),
  run,
});

const ClaudeResult = z.object({
  is_error: z.boolean(),
  num_turns: z.number().optional(),
  result: z.string().default(""),
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
export const toml = (s: string) => JSON.stringify(s).replaceAll("\u007f", "");

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
    // No usage, no tokens: a spend without them is not reported, never zero.
    tokens: res.usage ? claudeTokens(res.usage) : undefined,
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

async function askCodex({ dir, images, input, llm, system, tools }: ModelCall) {
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
      // The pinned binary, read-only, and none of the extras (CODEX_OFF). With `tools`, its MCP calls are approved by
      // config.
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
        ...(tools
          ? [
              `mcp_servers.${SERVER}.command=${toml(tools.command[0] ?? "")}`,
              `mcp_servers.${SERVER}.args=[${tools.command.slice(1).map(toml).join(",")}]`,
              `mcp_servers.${SERVER}.env={${Object.entries(tools.env)
                .map(([k, v]) => `${k}=${toml(v)}`)
                .join(",")}}`,
              `mcp_servers.${SERVER}.default_tools_approval_mode="approve"`,
              "features.view_image=false",
            ]
          : []),
      ].flatMap((c) => ["-c", c]),
      ...(tools ? CODEX_AGENT_OFF : CODEX_TOOLS).flatMap((f) => [
        "--disable",
        f,
      ]),
      ...["--json", "-o", reply],
      ...images.map((i) => `--image=${i}`),
    ],
    { env: modelEnv({ CODEX_HOME }), stdin: JSON.stringify(input) }
  );
  return {
    fields: {
      tokens: events.includes('"turn.completed"')
        ? codexTokens(events)
        : undefined,
    },
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
  /** How many of its calls a step runs at once (`inBatches`). */
  callsAtOnce: number;
  /** Tokens one call can hold, the smallest of its models and routes (fallback included). */
  contextTokens: number;
  effort?: Record<Tier, string>;
  /** Where its calls go first: `isOnline` asks it. */
  host: string;
  /** Its terms as an integration (`records/integration.ts`): what leaves the computer and what it takes. */
  integration: IntegrationTerms;
  /** The keys it takes, one per router of its routes. */
  keys: string[];
  /** What he calls it. */
  label: string;
  models: Record<Tier, string>;
  quota?: () => Promise<Quota | undefined>;
  /** Whether a call of it may be given tools (`Tools`): Codex only, the question cases' agent. */
  tools?: true;
}
// A call to an API engine costs the Mac nothing while it waits: on 12 Nov 2026, 103 calls at up to 96 at once on
// openrouter were each answered by their first host, none refused. allmodels at this many is not measured. An engine
// that starts a program on the Mac for each call (claude, codex) is held to a few.
const API_CALLS_AT_ONCE = 32;
const CLI_CALLS_AT_ONCE = 4;
/** An API engine: its calls go through its routes, which name its host and keys. */
function apiEngine(
  engine: Router,
  models: Record<Tier, string>,
  contextTokens: number,
  label: string,
  integration: IntegrationTerms
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
    callsAtOnce: API_CALLS_AT_ONCE,
    contextTokens,
    host: new URL(ROUTERS[engine].url).host,
    integration,
    keys: routers.map((r) => ROUTERS[r].key),
    label,
    models,
  };
}
/** What the AI is good for, the same whichever engine runs it: one example ask and the gist of Life's answer. */
const AI_VALUE = {
  answer: "Ana's invoice, the trip dates and the review you owe Sam.",
  ask: "What matters this week?",
};
// Context sizes as each lists them (9 Nov 2026): DeepSeek V4.1 Flash 1017 on OpenRouter's hosts and allmodels'
// abliterated one, 1,048,576; Claude Code's models, 200k; ponytail: Sol's 272k is a guess, read it if codex runs Life.
const PROVIDERS: Record<Engine, Provider> = {
  allmodels: apiEngine("allmodels", ALLMODELS_MODELS, 1_048_576, "allmodels", {
    privacy:
      "What Life reads goes to allmodels.io, only to hosts that keep no data.",
    requirements: [],
    value: AI_VALUE,
  }),
  claude: {
    ask: askClaude,
    callsAtOnce: CLI_CALLS_AT_ONCE,
    contextTokens: 200_000,
    host: "api.anthropic.com",
    integration: {
      privacy:
        "What Life reads goes to Anthropic through your Claude subscription, by the Claude Code app on this computer.",
      requirements: [
        { kind: "install", what: "claude_code" },
        { kind: "sign_in", with: "claude" },
      ],
      value: AI_VALUE,
    },
    keys: [],
    label: "Claude",
    models: CLAUDE_MODELS,
  },
  codex: {
    ask: askCodex,
    callsAtOnce: CLI_CALLS_AT_ONCE,
    contextTokens: 272_000,
    effort: CODEX_EFFORT,
    host: "chatgpt.com",
    integration: {
      privacy:
        "What Life reads goes to OpenAI through your ChatGPT subscription, by the Codex app on this computer.",
      requirements: [],
      value: AI_VALUE,
    },
    keys: [],
    label: "Codex",
    models: SOL,
    quota: codexQuota,
    tools: true,
  },
  openrouter: apiEngine(
    "openrouter",
    OPENROUTER_MODELS,
    1_048_576,
    "OpenRouter",
    {
      privacy:
        "What Life reads goes to OpenRouter, only to hosts that keep no data, paid from your OpenRouter credits.",
      requirements: [{ kind: "credits", with: "openrouter" }],
      value: AI_VALUE,
    }
  ),
};

/** How many calls of `llm`'s engine run at once. */
export const callsAtOnceOf = (llm: Llm) => PROVIDERS[llm.engine].callsAtOnce;

/** An engine's label and its terms as an integration, for the integration read. */
export const providerOf = (engine: Engine) => {
  const { integration, label } = PROVIDERS[engine];
  return { integration, label };
};

/**
 * The fewest characters a token holds, a low bound on purpose: a text of n characters is at most n / CHARS_PER_TOKEN
 * tokens. So what is sized by it fits, and a count of tokens made with it is a ceiling.
 */
export const CHARS_PER_TOKEN = 3;

/**
 * Characters of input one call of `llm` can take: its context less room for the answer (the API engines' cap, taken
 * for the CLI engines too), at `CHARS_PER_TOKEN` (a margin that covers the prompt). What a step reads whole is held
 * to it, never to a number of its own.
 */
export const callCharsOf = (llm: Llm) =>
  (PROVIDERS[llm.engine].contextTokens - MAX_TOKENS) * CHARS_PER_TOKEN;

/**
 * Whether Life is online: `engine`'s provider (his main engine's, unless said) answers at all (any HTTP status) within
 * 5 s. Offline (travelling, a VPN down) nothing Life schedules can work. The request carries no key and no text.
 */
export const isOnline = (engine = llmFor("main").engine) =>
  fetch(`https://${PROVIDERS[engine].host}`, {
    method: "HEAD",
    signal: AbortSignal.timeout(5000),
  }).then(
    () => true,
    () => false
  );

/** OpenRouter's credits, as its API reports them: the total he bought and the total he spent. */
const Credits = z.object({
  data: z.object({ total_credits: z.number(), total_usage: z.number() }),
});

/** OpenRouter's balance, or null with no key set or a call that failed. Privacy: only that key goes to OpenRouter (SECURITY.md, "What leaves the Mac"); off with another engine. */
async function creditsNow() {
  const key = process.env[ROUTERS.openrouter.key];
  if (!key) {
    return null;
  }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return null;
    }
    const { data } = Credits.parse(await res.json());
    return data.total_credits - data.total_usage;
  } catch {
    return null;
  }
}

/** Whether the Claude Code program `program` is signed in, by its own `auth status`; any failure is not. */
async function claudeSignedInNow(program: string) {
  try {
    const { stdout } = await exec([program, "auth", "status", "--json"], {
      env: cliEnv(),
      timeout: 5000,
    });
    return JSON.parse(stdout).loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * What the AI integration's requirements read, once for the integration read. It checks that the Claude Code program is
 * on this Mac and signed in (only when `engine`'s terms ask for them), that a router's key is set, that the OpenRouter
 * balance is above zero (only when its terms ask for it) and that its host answers. The credits call carries only the
 * key, to the provider already in use.
 */
export async function readEngineCheck(engine = readEngine()) {
  const { integration, host } = PROVIDERS[engine];
  const isClaude = integration.requirements.some(
    (r) =>
      (r.kind === "install" && r.what === "claude_code") ||
      (r.kind === "sign_in" && r.with === "claude")
  );
  const wantsCredits = integration.requirements.some(
    (r) => r.kind === "credits"
  );
  const router = engine in ROUTERS ? ROUTERS[engine as Router] : undefined;
  // readProgram gives a bare name back when `Bun.which` finds nothing.
  const program = isClaude ? readProgram("claude") : "claude";
  return {
    claudeFound: !isClaude || program !== "claude",
    claudeSignedIn: !isClaude || (await claudeSignedInNow(program)),
    credits: wantsCredits ? await creditsNow() : null,
    host,
    // A router's key, the page where it is made, and whether it is set.
    key: router && {
      name: router.key,
      opens: router.keysAt,
      set: Boolean(process.env[router.key]),
    },
    online: await isOnline(engine),
  };
}

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
 * One shot with no tools (but `tools`, the question cases' agent's one MCP server), no other MCP servers and no CLAUDE.md: `prompts/<prompt>.md` is the whole system prompt and
 * `input` (as JSON) the whole user message. Code assembles everything the model sees, so the call stays small.
 * `context` (as JSON) is appended to the system prompt: the same for every call of a run, so it is cached.
 * The input and the reply are kept in `dir`, so anything made from a call can be checked against exactly what the
 * model read. `images` (JPEG or PNG paths) follow the input, in order. Returns the reply's JSON; every call, failed or
 * not, is one `model.run` line, with what it read (`reads`, by source: a call that names none is refused before it is
 * made) and, through a router, what each router it tried took (`spentByRouter`: dollars, tokens, whether every try was priced).
 */
export async function askOnce(opts: {
  context?: unknown;
  dir: string;
  images?: string[];
  input: unknown;
  llm: Llm;
  /** The call parts it has on (`models/prompt-parts.ts`): their paragraphs are shown and its name says so. */
  callParts?: readonly string[];
  prompt: string;
  /** The units it is shown, counted by source (`readsOf`, memory/run.ts). */
  reads: CallReads;
  run: string;
  /** The one exception to "no tools": Life's connector, reads only, for the question cases' agent. */
  tools?: Tools;
}) {
  const { dir, llm, reads } = opts;
  if (!Object.values(reads).some((n) => (n ?? 0) > 0)) {
    throw new Error(
      `a model call names what it reads: ${opts.prompt} named nothing`
    );
  }
  if (opts.tools && !PROVIDERS[llm.engine].tools) {
    throw new Error(`${llm.engine} runs no tools: only Codex is given any`);
  }
  const context =
    opts.context === undefined
      ? ""
      : `\n\n<context>\n${JSON.stringify(opts.context)}\n</context>\n`;
  const system = `${promptText(opts.prompt, opts.callParts)}${context}`;
  const made = {
    ...stamp(llm, opts.prompt, opts.run, opts.callParts),
    effort: llm.effort,
    reads,
  };
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
      tools: opts.tools,
    });
    ({ fields } = answer);
    if (answer.refusal) {
      throw new Error(answer.refusal);
    }
    const json = extractJson(answer.text);
    log("model.run", { ...made, ...fields, ms: ms(), ok: true });
    return json;
  } catch (e) {
    // What failed here is the model's or its provider's: its words can echo the call, so every log keeps its type only.
    log("model.run", {
      ...made,
      ...fields,
      ...errorOf(fromModel(e)),
      ms: ms(),
      ok: false,
    });
    // Marked, so every catch above logs it by its type too (a thrown string becomes such an error).
    throw fromModel(e);
  }
}
