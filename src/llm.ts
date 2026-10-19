// What every model step shares: run one headless call on the owner's engine, `claude -p` or `codex exec`, getting back
// its JSON reply, with no tools.
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { log } from "./log";
import { exec } from "./proc";
import { Engine } from "./schema";
import { ROOT } from "./truth";

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

/** The engine, model and (codex) reasoning effort one run uses. */
export interface Llm {
  effort?: string;
  engine: Engine;
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

/** Read once at the start of a run, so the engine cannot change halfway through it. */
export async function llmFor(tier: Tier): Promise<Llm> {
  const engine = await readEngine();
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

/** `codex/gpt-6.1-sol (low)` for the log and the nightly email. */
export const describeLlm = (l: Llm) =>
  `${l.engine}/${l.model}${l.effort ? ` (${l.effort})` : ""}`;

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

/**
 * One shot with no tools, no MCP servers and no CLAUDE.md: `prompts/<prompt>.md` is the whole system prompt and
 * `input` (as JSON) the whole user message. Code assembles everything the model sees, so the call stays small.
 * `context` (as JSON) is appended to the system prompt: the same for every call of a run, so it is cached.
 * The input and the raw reply are kept in `dir`, so anything made from a call can be checked against exactly what the
 * model read. `images` (JPEG or PNG paths) follow the input, in order. Returns the reply's JSON.
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
  const made = stamp(llm, opts.prompt, opts.run);
  const reply = join(
    dir,
    llm.engine === "claude" ? "claude.jsonl" : "codex.txt"
  );
  const images = opts.images ?? [];
  const codex = llm.engine === "codex";
  if (codex && !(await Bun.file(join(CODEX_HOME, "auth.json")).exists())) {
    // codex refuses a CODEX_HOME that doesn't exist, even to log in.
    await mkdir(CODEX_HOME, { recursive: true });
    throw new Error(
      `codex has no login in ${CODEX_HOME}: run CODEX_HOME="${CODEX_HOME}" codex login --device-auth`
    );
  }
  // Both engines start in an empty folder outside the repo: inside it, claude loads the project's auto-memory and codex
  // its AGENTS.md, and recorded content must reach the model with nothing but the prompt.
  const cwd = await mkdtemp(join(tmpdir(), "life-llm-"));
  const args =
    llm.engine === "claude"
      ? [
          ...["claude", "-p", "--model", llm.model, "--verbose"],
          ...[
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
          ],
          ...["--tools", "", "--strict-mcp-config", "--setting-sources", ""],
          ...["--no-session-persistence", "--system-prompt", system],
        ]
      : [
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
        ];
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "input.json"), JSON.stringify(opts.input, null, 1));
  const started = performance.now();
  const { code, killed, stderr, stdout } = await exec(args, {
    cwd,
    env: modelEnv(codex ? { CODEX_HOME } : {}),
    stdin: codex
      ? JSON.stringify(opts.input)
      : JSON.stringify({
          message: {
            content: [
              { text: JSON.stringify(opts.input), type: "text" },
              ...(await Promise.all(images.map(imageBlock))),
            ],
            role: "user",
          },
          type: "user",
        }),
    timeout: MODEL_TIMEOUT_MS,
  }).finally(() => rm(cwd, { force: true, recursive: true }));
  const ms = Math.round(performance.now() - started);
  if (code !== 0) {
    // claude reports its errors on stdout, codex on stderr: keep the tail of both.
    const detail = [stderr, stdout]
      .map((t) => t.trim().slice(-300))
      .filter(Boolean)
      .join(" | ");
    log("model.run", { ...made, code, error: detail, ms, ok: false });
    throw new Error(
      `${llm.engine} ${killed ? `timed out after ${MODEL_TIMEOUT_MS / 1000} s` : `exited ${code}`}: ${detail}`
    );
  }
  if (codex) {
    log("model.run", { ...made, effort: llm.effort, ms, ok: true });
    return extractJson(await Bun.file(reply).text());
  }
  await Bun.write(reply, stdout);
  // A stream of events, the result last.
  const res = ClaudeResult.parse(
    JSON.parse(stdout.trim().split("\n").at(-1) ?? "")
  );
  log("model.run", {
    ...made,
    costUsd: res.total_cost_usd,
    ms,
    ok: !res.is_error,
    turns: res.num_turns,
    usage: res.usage,
  });
  if (res.is_error) {
    throw new Error(`claude reported an error: ${res.result.slice(-300)}`);
  }
  return extractJson(res.result);
}
