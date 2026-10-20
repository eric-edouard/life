// What every model step shares: run one headless call, getting back its JSON reply, with no tools: on the owner's
// engine (`claude -p` or `codex exec`), or for the bench alone through OpenRouter.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { log } from "./log";
import { exec } from "./proc";
import { Engine, Runner } from "./schema";
import { DATA, ROOT } from "./truth";

const FENCED = /```(?:json)?\s*\n(\{[\s\S]*?\})\s*\n```/g;
const MODEL_TIMEOUT_MS = 20 * 60_000;

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

/** What a step needs: repos and files fast, pages main, moments and extract deep (~/Life/docs/evals/events-2026-10-18.md). */
export type Tier = "fast" | "main" | "deep";

/** The runner, model and reasoning effort one run uses (claude takes one only from `LIFE_LLM`; an OpenRouter model is `author/model@host`). */
export interface Llm {
  effort?: string;
  engine: Runner;
  model: string;
}

const SETTINGS = join(ROOT, "derived", "settings.json");
const Settings = z.object({ engine: Engine.default("claude") });
const CLAUDE_MODELS: Record<Tier, string> = {
  deep: "opus",
  fast: "haiku",
  main: "sonnet",
};
// Same model as lifelog. Older codex clients reject it, and this Mac has several (an nvm global, a broken
// /usr/local one, the app's bundled one), so Life runs the version pinned in package.json, natively (launchd has no node).
const CODEX_MODEL = "gpt-6.1-sol";
const CODEX_BIN = join(
  ROOT,
  "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"
);
// Codex always loads AGENTS.md from its home, and no flag turns that off, so Life has its own home with a login of
// its own (`CODEX_HOME=<this> codex login --device-auth`, once) and no instruction files. The repo's own AGENTS.md is
// kept out by running in an empty temp folder and `project_doc_max_bytes=0`; `skills.include_instructions=false` drops
// the skills catalog.
const CODEX_HOME = join(homedir(), "Library/Application Support/Life/codex");
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

/** The engine he chose; a corrupt settings file throws, never a silent switch of engine (his transcripts go where he said). */
export const readEngine = (path = SETTINGS): Engine =>
  existsSync(path)
    ? Settings.parse(JSON.parse(readFileSync(path, "utf8"))).engine
    : "claude";

export async function setEngine(engine: Engine) {
  await Bun.write(SETTINGS, `${JSON.stringify({ engine })}\n`);
}

/**
 * `LIFE_LLM=engine/model[/effort]`: one process's model for every tier, set by the bench for a candidate and for its
 * judge (`scripts/bench.ts`), never by launchd. Refused on his own data: what is written there comes from his engine.
 */
export function llmOverride(
  set = process.env.LIFE_LLM,
  data = DATA
): Llm | undefined {
  if (!set) {
    return;
  }
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
  if (real(data) === real(join(homedir(), "Life"))) {
    throw new Error(
      "LIFE_LLM is for a copy of the data (LIFE_DATA), never ~/Life"
    );
  }
  const [engine = "", ...rest] = set.split("/");
  const effort = EFFORTS.includes(rest.at(-1) ?? "") ? rest.pop() : undefined;
  if (rest.length === 0) {
    throw new Error(`LIFE_LLM is engine/model[/effort], not ${set}`);
  }
  return { effort, engine: Runner.parse(engine), model: rest.join("/") };
}

/** An `Llm` as `LIFE_LLM` names it, `engine/model[/effort]`: for `LIFE_LLM`, the log and the nightly email. */
export const llmSpec = (l: Llm) =>
  [l.engine, l.model, l.effort].filter(Boolean).join("/");

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Read once at the start of a run, so the engine cannot change halfway through it. */
export function llmFor(tier: Tier): Llm {
  const set = llmOverride();
  if (set) {
    return set;
  }
  const engine = readEngine();
  return engine === "claude"
    ? { engine, model: CLAUDE_MODELS[tier] }
    : { effort: CODEX_EFFORT[tier], engine, model: CODEX_MODEL };
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

// A TOML basic string for `-c key=value`; JSON's escapes are TOML's, bar a raw DEL.
const toml = (s: string) => JSON.stringify(s).replaceAll("\u007f", "");

const promptText = (prompt: string) =>
  Bun.file(join(ROOT, "prompts", `${prompt}.md`)).text();

const MODEL_ENV = "HOME LANG LC_ALL LOGNAME PATH SHELL TERM TMPDIR USER".split(
  " "
);

/** Only what a CLI needs to run: no API key (bill the subscriptions) and none of Life's .env secrets. */
const modelEnv = (extra: Record<string, string> = {}) => ({
  ...Object.fromEntries(
    MODEL_ENV.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))
  ),
  ...extra,
});

/** An image as claude's stream-json input takes it. */
const imageBlock = async (path: string) => ({
  source: {
    data: Buffer.from(await Bun.file(path).bytes()).toString("base64"),
    media_type: Bun.file(path).type,
    type: "base64",
  },
  type: "image",
});

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
/** Room for a day's moments and their reasoning; every bench host allows at least this much. */
const OPENROUTER_MAX_TOKENS = 131_072;
const OpenRouterReply = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({ content: z.string().nullable() }),
      })
    )
    .min(1),
  // Not in OpenRouter's documented schema, but sent: without it the host can't be checked, so the call fails.
  provider: z.string(),
  usage: z.object({ cost: z.number().optional() }).loose(),
});
const NOT_ALNUM = /[^a-z0-9]/g;
const slug = (s: string) => s.toLowerCase().replaceAll(NOT_ALNUM, "");

/** One call as a runner gets it. */
interface Call {
  dir: string;
  images: string[];
  input: unknown;
  llm: Llm;
  system: string;
}
/** A runner's reply: its text, and what the log records of the call besides the time. */
interface Answer {
  fields?: Record<string, unknown>;
  text: string;
}
/** A call that answered but is refused: what it cost is still logged. */
const refused = (message: string, fields: Answer["fields"]) =>
  Object.assign(new Error(message), { fields });

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

async function askClaude({ dir, images, input, llm, system }: Call) {
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
    turns: res.num_turns,
    usage: res.usage,
  };
  if (res.is_error) {
    throw refused(
      `claude reported an error: ${res.result.slice(-300)}`,
      fields
    );
  }
  return { fields, text: res.result };
}

async function askCodex({ dir, images, input, llm, system }: Call) {
  if (!(await Bun.file(join(CODEX_HOME, "auth.json")).exists())) {
    // codex refuses a CODEX_HOME that doesn't exist, even to log in.
    await mkdir(CODEX_HOME, { recursive: true });
    throw new Error(
      `codex has no login in ${CODEX_HOME}: run CODEX_HOME="${CODEX_HOME}" codex login --device-auth`
    );
  }
  const reply = join(dir, "codex.txt");
  await cli(
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
      ...["-o", reply],
      ...images.map((i) => `--image=${i}`),
    ],
    { env: modelEnv({ CODEX_HOME }), stdin: JSON.stringify(input) }
  );
  return { text: await Bun.file(reply).text() };
}

/**
 * One call through OpenRouter, the bench's alone (`llmOverride`): pinned to the host after `@`, in fp8 (each bench
 * host's endpoint for its model is, 20 Oct 2026), routed only to endpoints that keep nothing (`zdr`, `data_collection: deny`), no
 * fallback, every parameter honored, and refused when another host served it. No tools; the key
 * (OPENROUTER_API_KEY in .env) is read here only.
 */
async function askOpenRouter({ dir, images, input, llm, system }: Call) {
  const key = process.env.OPENROUTER_API_KEY;
  const [model, host] = llm.model.split("@");
  if (!(key && host)) {
    throw new Error(
      "openrouter needs OPENROUTER_API_KEY in .env and a model as author/model@host"
    );
  }
  if (images.length > 0) {
    throw new Error("the bench sends no images through OpenRouter");
  }
  const res = await fetch(OPENROUTER, {
    body: JSON.stringify({
      max_tokens: OPENROUTER_MAX_TOKENS,
      messages: [
        { content: system, role: "system" },
        { content: JSON.stringify(input), role: "user" },
      ],
      model,
      provider: {
        allow_fallbacks: false,
        data_collection: "deny",
        only: [host],
        quantizations: ["fp8"],
        require_parameters: true,
        zdr: true,
      },
      ...(llm.effort ? { reasoning: { effort: llm.effort } } : {}),
    }),
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  const text = await res.text();
  await Bun.write(join(dir, "openrouter.json"), text);
  if (!res.ok) {
    throw new Error(`openrouter ${res.status}: ${text.slice(-300)}`);
  }
  const reply = OpenRouterReply.parse(JSON.parse(text));
  const [choice] = reply.choices;
  const fields = {
    costUsd: reply.usage.cost,
    host: reply.provider,
    usage: reply.usage,
  };
  if (slug(reply.provider) !== slug(host)) {
    throw refused(
      `openrouter: served by ${reply.provider}, not ${host}`,
      fields
    );
  }
  if (choice?.finish_reason !== "stop" || !choice.message.content) {
    throw refused(`openrouter: stopped (${choice?.finish_reason})`, fields);
  }
  return { fields, text: choice.message.content };
}

const RUNNERS: Record<Runner, (call: Call) => Promise<Answer>> = {
  claude: askClaude,
  codex: askCodex,
  openrouter: askOpenRouter,
};

/**
 * One shot with no tools, no MCP servers and no CLAUDE.md: `prompts/<prompt>.md` is the whole system prompt and
 * `input` (as JSON) the whole user message. Code assembles everything the model sees, so the call stays small.
 * `context` (as JSON) is appended to the system prompt: the same for every call of a run, so it is cached.
 * The input and the raw reply are kept in `dir`, so anything made from a call can be checked against exactly what the
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
    const answer = await RUNNERS[llm.engine]({
      dir,
      images: opts.images ?? [],
      input: opts.input,
      llm,
      system,
    });
    ({ fields } = answer);
    const json = extractJson(answer.text);
    log("model.run", { ...made, ...fields, ms: ms(), ok: true });
    return json;
  } catch (e) {
    log("model.run", {
      ...made,
      ...(fields ?? (e as { fields?: Answer["fields"] }).fields),
      error: (e as Error).message,
      ms: ms(),
      ok: false,
    });
    throw e;
  }
}
