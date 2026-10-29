// What every model step shares: run one headless call, getting back its JSON reply, with no tools: on the owner's
// engine (`claude -p` or `codex exec` on his subscriptions, or allmodels' API); and how full his Codex quota is. The
// one call with tools is the agent bench's (scripts/bench-agent.ts): Life's own connector, frozen, and nothing else.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MIN } from "../core/clock";
import { log } from "../core/log";
import { Engine } from "../core/names";
import { isHis, LIFE_CODE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { CODEX, cliEnv, MACHINE_DIR } from "../core/platform";
import { exec, firstLine } from "../core/proc";
import { settings } from "../core/settings";

const FENCED = /```(?:json)?\s*\n(\{[\s\S]*?\})\s*\n```/g;
const MODEL_TIMEOUT_MS = 20 * MIN;

/**
 * The model's reply is meant to be bare JSON; tolerate a fence or a stray line around it, and a reply that corrects
 * itself with a second fenced object (the last one wins).
 */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("no JSON object in the model's reply");
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    const last = [...text.matchAll(FENCED)].at(-1)?.[1];
    if (last === undefined) {
      throw e;
    }
    return JSON.parse(last);
  }
}

/**
 * What a step needs (each step names its tier in `begin`): files, repos, closeness and imports fast, pages main, moments
 * and extract deep (~/Life/docs/evals/events-2026-10-18.md).
 */
export type Tier = "fast" | "main" | "deep";

/** The engine, model and reasoning effort one run uses (claude takes one only from `LIFE_LLM`; an allmodels model is `author/model@host[,host]`). */
export interface Llm {
  effort?: string;
  engine: Engine;
  model: string;
}

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
// The bench's agent reaches MCP tools only through code mode's `exec` (a V8 isolate with no file system or network),
// so it keeps that and still has no shell; `apply_patch`, nested there, meets the read-only sandbox. Its nested
// `clock__curr_time` reads the real time: no flag removes it, so the bench's prompt says not to (verified 21 Oct on
// codex 0.162.1 against a fake provider, no quota spent).
const CODEX_AGENT_OFF = ["shell_tool", "unified_exec", "sleep_tool"];
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
 * allmodels' effort by tier: both hosts take only none, low, high and max (Hopper xhigh too) and refuse "medium"
 * (checked 28 Oct 2026), so the pages think at high. Hopper thinks more at high than at low; Refuseless a little more,
 * and it thinks even at none.
 */
const ALLMODELS_EFFORT: Record<Tier, string> = {
  deep: "high",
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

/** The tokens of a call (on its `model.run` line), or of a run's calls: input (cached included), cached input, output. */
export interface Tokens {
  cached: number;
  input: number;
  output: number;
}
export const NONE: Tokens = { cached: 0, input: 0, output: 0 };
export const add = (a: Tokens, b: Tokens): Tokens => ({
  cached: a.cached + b.cached,
  input: a.input + b.input,
  output: a.output + b.output,
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

/** An image as claude's stream-json input takes it (allmodels' call builds its data URL from it). */
const imageBlock = async (path: string) => ({
  source: {
    data: Buffer.from(await Bun.file(path).bytes()).toString("base64"),
    media_type: Bun.file(path).type,
    type: "base64",
  },
  type: "image",
});

const ChatReply = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({ content: z.string().nullable() }),
      })
    )
    .min(1),
  // The host that served it, checked against his hosts.
  provider: z.string().optional(),
  usage: z
    .object({
      completion_tokens: z.number(),
      prompt_tokens: z.number(),
      prompt_tokens_details: z.object({ cached_tokens: z.number() }).nullish(),
    })
    .nullish(),
});
const NOT_ALNUM = /[^a-z0-9]/g;
const slug = (s: string) => s.toLowerCase().replaceAll(NOT_ALNUM, "");

/** An MCP server over stdio, `life`: the only tools a call may have (the agent bench's frozen connector). */
export interface Tools {
  command: string[];
  env: Record<string, string>;
}
const SERVER = "life";

/** One call as a runner gets it. */
interface Call {
  dir: string;
  images: string[];
  input: unknown;
  llm: Llm;
  system: string;
  tools?: Tools;
}
/**
 * A runner's reply: its text, and what the log records of the call besides the time. `refusal`: it answered, but the
 * answer is not used (still logged with what it cost).
 */
interface Answer {
  fields?: Record<string, unknown>;
  refusal?: string;
  text: string;
}

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

async function askClaude({ dir, images, input, llm, system, tools }: Call) {
  const stdout = await cli(
    "claude",
    () => [
      ...["claude", "-p", "--model", llm.model, "--verbose"],
      ...(llm.effort ? ["--effort", llm.effort] : []),
      ...["--input-format", "stream-json", "--output-format", "stream-json"],
      ...["--tools", "", "--strict-mcp-config", "--setting-sources", ""],
      ...(tools
        ? [
            ...["--allowedTools", `mcp__${SERVER}`, "--mcp-config"],
            JSON.stringify({
              mcpServers: {
                [SERVER]: {
                  args: tools.command.slice(1),
                  command: tools.command[0],
                  env: tools.env,
                },
              },
            }),
          ]
        : []),
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

async function askCodex({ dir, images, input, llm, system, tools }: Call) {
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
      // The pinned binary, read-only, and none of the extras (CODEX_OFF). With the bench's connector, its MCP calls are
      // approved by config.
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

const ALLMODELS_URL = "https://api.allmodels.io/oai/chat/completions";
const ALLMODELS_KEY = "ALLMODELS_API_KEY";
/** Room for a day's moments and their reasoning: every host of its tier models allows at least this (28 Oct 2026). */
const ALLMODELS_MAX_TOKENS = 131_072;

/**
 * One call through allmodels' OpenAI-shaped API with his key, at the tier's reasoning effort, no idle cut: the model
 * goes only to the hosts after `@`, tried in that order (allmodels moves to the next before output begins when one
 * fails), and is refused when any other host served it. Its answer is kept in the call's folder; a refusal unless it
 * stopped with some text.
 */
async function askAllModels({
  dir,
  images,
  input,
  llm,
  system,
}: Call): Promise<Answer> {
  const key = process.env[ALLMODELS_KEY];
  const [model, list = ""] = llm.model.split("@");
  const hosts = list.split(",").filter(Boolean);
  if (!(key && hosts.length)) {
    throw new Error(
      `allmodels needs ${ALLMODELS_KEY} and a model as author/model@host[,host], not ${llm.model}`
    );
  }
  const pictures = await Promise.all(
    images.map(async (path) => {
      const { source } = await imageBlock(path);
      return {
        image_url: { url: `data:${source.media_type};base64,${source.data}` },
        type: "image_url",
      };
    })
  );
  const res = await fetch(ALLMODELS_URL, {
    body: JSON.stringify({
      max_tokens: ALLMODELS_MAX_TOKENS,
      messages: [
        { content: system, role: "system" },
        {
          content: [{ text: JSON.stringify(input), type: "text" }, ...pictures],
          role: "user",
        },
      ],
      model,
      provider: { allow_fallbacks: true, only: hosts, order: hosts },
      reasoning_effort: llm.effort,
    }),
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    // Bun's 5-minute idle timer would cut a long call that sends nothing until it is done.
    timeout: false,
  });
  const text = await res.text();
  await Bun.write(join(dir, "allmodels.json"), text);
  if (!res.ok) {
    throw new Error(`allmodels ${res.status}: ${text.slice(-300)}`);
  }
  return answerOf(hosts, ChatReply.parse(JSON.parse(text)));
}

/** allmodels' reply as a runner's answer: refused when a host not in `hosts` served it, or it stopped without text. */
function answerOf(hosts: string[], reply: z.infer<typeof ChatReply>): Answer {
  const [choice] = reply.choices;
  const u = reply.usage;
  const served = reply.provider ?? "";
  const stopped =
    choice?.finish_reason === "stop" && choice.message.content
      ? undefined
      : `allmodels: stopped (${choice?.finish_reason})`;
  return {
    fields: {
      host: served,
      tokens: u && {
        cached: u.prompt_tokens_details?.cached_tokens ?? 0,
        input: u.prompt_tokens,
        output: u.completion_tokens,
      },
    },
    refusal:
      served && hosts.some((h) => slug(h) === slug(served))
        ? stopped
        : `allmodels: served by ${served || "an unnamed host"}, not ${hosts.join(" or ")}`,
    text: choice?.message.content ?? "",
  };
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
 * whether it may run tools (his subscriptions only), and how full its quota is when it has one.
 */
interface Provider {
  ask: (call: Call) => Promise<Answer>;
  effort?: Record<Tier, string>;
  key?: string;
  models: Record<Tier, string>;
  quota?: () => Promise<Quota | undefined>;
  tools: boolean;
}
const PROVIDERS: Record<Engine, Provider> = {
  allmodels: {
    ask: askAllModels,
    effort: ALLMODELS_EFFORT,
    key: ALLMODELS_KEY,
    models: ALLMODELS_MODELS,
    tools: false,
  },
  claude: { ask: askClaude, models: CLAUDE_MODELS, tools: true },
  codex: {
    ask: askCodex,
    effort: CODEX_EFFORT,
    models: SOL,
    quota: codexQuota,
    tools: true,
  },
};

/** The key each API engine takes, by engine: the app asks for it by this name. */
export const engineKeys = () =>
  Object.fromEntries(
    Object.entries(PROVIDERS).flatMap(([e, p]) => (p.key ? [[e, p.key]] : []))
  );

/**
 * Whether this process's calls (on `engine`, his setting unless a bench says) go to an engine with a quota to read (his
 * Codex plan); `quota` and `metered` read one only then. The others count only tokens.
 */
export const hasQuota = (engine?: Engine) =>
  PROVIDERS[llmFor("main", engine).engine].quota !== undefined;

/**
 * One shot with no tools (but the bench's `tools`), no other MCP servers and no CLAUDE.md: `prompts/<prompt>.md` is the whole system prompt and
 * `input` (as JSON) the whole user message. Code assembles everything the model sees, so the call stays small.
 * `context` (as JSON) is appended to the system prompt: the same for every call of a run, so it is cached.
 * The input and the raw reply are kept in `dir`, so anything made from a call can be checked against exactly what the
 * model read. `images` (JPEG or PNG paths) follow the input, in order. Returns the reply's JSON; every call, failed or
 * not, is one `model.run` line.
 */
export async function askOnce(opts: {
  context?: unknown;
  /** The one exception to "no tools": the agent bench's frozen connector. */
  tools?: Tools;
  dir: string;
  images?: string[];
  input: unknown;
  llm: Llm;
  prompt: string;
  run: string;
}) {
  const { dir, llm } = opts;
  if (opts.tools && !PROVIDERS[llm.engine].tools) {
    throw new Error(
      `${llm.engine} runs no tools: tools run on his subscriptions only`
    );
  }
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
