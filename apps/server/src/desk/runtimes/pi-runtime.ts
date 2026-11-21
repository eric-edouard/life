import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { log } from "../../core/log";
import { LIFE_CODE_DIR, LIFE_STATE_DIR } from "../../core/paths";
import { HOME, isOwnLife } from "../../core/platform";
import { exec } from "../../core/proc";
import { piRouteOf } from "../../models/llm";
import { MAX_TOKENS, routingOf } from "../../models/routers";
import type { ClaudeHookGroup } from "./claude-hooks";
import type { Agent, RunEnd, Runtime, Update, Usage } from "./contract";
import {
  PI_EXTENSION_COMMAND,
  PI_EXTENSION_ENV,
  PI_PROVIDER,
  type PiProvider,
} from "./pi-extension";
import { loginEnvLess, readSendFacts, type SessionState } from "./runtime-rows";
import {
  type Connection,
  LAUNCH_WITHIN_MS,
  type Open,
  type SessionRow,
  sessionRuntime,
  spawnFor,
} from "./session-runtime";

// The pi runtime (the owner's decisions of 22 Nov 2026, `docs/plans/pi-runtime.md`): the pinned pi
// (`@earendil-works/pi-coding-agent`), run by the helper as bun, in its RPC mode (JSONL on stdio), one process per
// turn, with Life's extension (`pi-extension.ts`: the send guard inside pi, the door, Life's provider). Its sessions are
// pi's JSONL files under the desk's own folder, its settings an agent folder of Life's: nothing is written into `~/.pi`.
// The model is the memory's OpenRouter route on its hosts that keep nothing (`piRouteOf`), with Life's key. An agent of
// his own Life gets his login environment less the OpenRouter key, his context files, his skills, his global Claude
// instructions (imports followed) as the agent folder's `AGENTS.md`, his Claude hooks and the web tools; a second
// Life's gets none of them and no built-in tool: its door alone.

/** pi's command line, as the app bundles it (`scripts/helper.ts`). */
export const PI_CLI = join(
  LIFE_CODE_DIR,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js"
);
/** Life's pi extension: bundled under the app's resources (`scripts/helper.ts`), the source in a checkout. */
const PI_EXTENSION = ["js", "ts"]
  .map((e) =>
    join(
      LIFE_CODE_DIR,
      "apps",
      "server",
      "src",
      "desk",
      "runtimes",
      `pi-extension.${e}`
    )
  )
  .find(existsSync);
/** The key pi's provider takes: Life's own, from its environment. */
const KEY = "OPENROUTER_API_KEY";

/** The desk's word for pi's one model (the phone's choice, `RuntimeName.models`): the provider's model, whatever its id. */
const PI_MODEL_WORD = "flash";

/** Where pi keeps the desk's sessions and settings, the provider it asks, and the effort an agent naming none thinks at. */
export interface PiPlace {
  /** His Claude folder: his instructions and hooks, for his own Life. */
  claude: string;
  dir: string;
  effort?: string;
  provider: PiProvider;
}

/** The provider every pi agent asks: the memory's OpenRouter route, its hosts as Life's routing on every request. */
export function lifeProviderOf(): PiProvider {
  const route = piRouteOf();
  return {
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      {
        compat: { openRouterRouting: routingOf(route.hosts) },
        // OpenRouter sends each call's cost; pi's own count is left at none.
        contextWindow: route.contextTokens,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: route.model,
        input: ["text", "image"],
        maxTokens: MAX_TOKENS,
        name: route.model,
        reasoning: true,
      },
    ],
  };
}

/** pi's row: what `sessionRuntime` reads, and the command and environment of a run. */
export interface PiRow extends SessionRow {
  spawn: (
    a: Agent,
    ref: string,
    isNew: boolean
  ) => Promise<{ command: string[]; env: Record<string, string> }>;
}

/** The settings of Life's agent folder for pi, written whole at each spawn. */
const settingsOf = (claude: string | undefined) => ({
  // A repo's own `.pi` never loads (the extension refuses it too): it could rewrite a request.
  defaultProjectTrust: "never",
  extensions: [
    "-builtin:codemode",
    "-builtin:tool-search",
    "-builtin:llama.cpp",
  ],
  quietStartup: true,
  // His skills where Claude Code reads them, beside `~/.agents/skills`, which pi reads itself.
  skills: claude ? [join(claude, "skills")] : [],
});

/** His Claude folder, where Claude Code reads his instructions and hooks (a test passes its own). */
const CLAUDE_HOME = join(HOME, ".claude");

/** A file's text, or none when it is not there. */
const readTextIfThere = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {}
};

/** How deep `@` imports are followed, as Claude Code follows them. */
const IMPORT_DEPTH = 5;

/** `file`'s text, each line that is an `@` import replaced by the file it names (from `file`'s folder, `~/` from home). */
function readWithImports(file: string, depth: number): string | undefined {
  return readTextIfThere(file)
    ?.split("\n")
    .map((l) => {
      const at = /^@(\S+)$/.exec(l.trim())?.[1];
      if (!at || depth === 0) {
        return l;
      }
      const path = at.startsWith("~/")
        ? join(HOME, at.slice(2))
        : resolve(dirname(file), at);
      return readWithImports(path, depth - 1) ?? l;
    })
    .join("\n");
}

/** His global instructions as Claude Code reads them (`<claude>/CLAUDE.md`, imports followed): pi follows no import. */
export const readClaudeInstructions = (claude: string) =>
  readWithImports(join(claude, "CLAUDE.md"), IMPORT_DEPTH);

/** His Claude `PreToolUse` hooks (`<claude>/settings.json`), for the extension to run on each shell call. */
export const readClaudeHooks = (claude: string): ClaudeHookGroup[] => {
  try {
    return (
      JSON.parse(readTextIfThere(join(claude, "settings.json")) ?? "{}").hooks
        ?.PreToolUse ?? []
    );
  } catch {
    return [];
  }
};

/** The session file of `ref` under `sessions`, if pi wrote one (`<time>_<ref>.jsonl`). */
const sessionFileOf = (sessions: string, ref: string) => {
  try {
    const name = new Bun.Glob(`*_${ref}.jsonl`).scanSync(sessions).next().value;
    return name ? join(sessions, name) : undefined;
  } catch {
    // no sessions folder yet
  }
};

/**
 * pi's row for his own Life, or a second Life's (`isOwn` false: no login environment, context file, skill or built-in
 * tool). `place` is where its sessions and settings live and the provider it asks (a test passes its own).
 */
export function piRowOf(
  isOwn = isOwnLife(),
  place: PiPlace = {
    claude: CLAUDE_HOME,
    dir: join(LIFE_STATE_DIR, "desk", "pi"),
    effort: piRouteOf().effort,
    provider: lifeProviderOf(),
  }
): PiRow {
  const sessions = join(place.dir, "sessions");
  const agentDir = join(place.dir, "agent");
  const [model] = place.provider.models ?? [];
  /** What agent `a`'s run on session `ref` needs (the session file to resume, its model and effort), or why it can't run. */
  const runOf = (a: Agent, ref: string, isNew: boolean) => {
    if (!(PI_EXTENSION && model)) {
      throw new Error("Life's pi extension or its model is missing");
    }
    if (a.model && a.model !== PI_MODEL_WORD) {
      throw new Error(
        `pi runs its one model (${PI_MODEL_WORD}), not ${a.model}`
      );
    }
    const file = isNew ? undefined : sessionFileOf(sessions, ref);
    if (!(isNew || file)) {
      throw new Error(`pi has no session ${ref}`);
    }
    return {
      effort: a.effort ?? place.effort,
      extension: PI_EXTENSION,
      file,
      id: model.id,
    };
  };
  return {
    block: () =>
      Promise.resolve(
        [
          [!existsSync(PI_CLI), "pi is missing"],
          [!PI_EXTENSION, "Life's pi extension is missing"],
          [!process.env[KEY], `pi needs ${KEY}`],
        ].find(([isMissing]) => isMissing)?.[1] as string | undefined
      ),
    // ponytail: no link until Life's app shows a pi session (the owner's decision 2 of 22 Nov 2026, PR 6).
    link: () => "",
    async readSessionState(ref): Promise<SessionState> {
      // A pi on this session that the desk does not drive (his terminal, an orphaned run): never a second one beside it.
      const { code } = await exec([
        "pgrep",
        "-f",
        "--",
        `--session(-id)?[= ][^ ]*${ref}`,
      ]);
      if (code === 0) {
        return "running";
      }
      return sessionFileOf(sessions, ref) ? "idle" : "gone";
    },
    async spawn(a, ref, isNew) {
      const { effort, extension, file, id } = runOf(a, ref, isNew);
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify(settingsOf(isOwn ? place.claude : undefined))
      );
      // His global instructions, as his Claude sessions read them; a second Life's agent reads none.
      const instructions = isOwn
        ? readClaudeInstructions(place.claude)
        : undefined;
      if (instructions) {
        writeFileSync(join(agentDir, "AGENTS.md"), instructions);
      } else {
        rmSync(join(agentDir, "AGENTS.md"), { force: true });
      }
      return {
        command: [
          process.execPath,
          PI_CLI,
          "--mode",
          "rpc",
          "--provider",
          PI_PROVIDER,
          "--model",
          id,
          "--session-dir",
          sessions,
          ...(file
            ? ["--session", file]
            : ["--session-id", ref, "--name", a.title]),
          ...(effort ? ["--thinking", effort] : []),
          "-e",
          extension,
          ...(isOwn
            ? []
            : ["--no-context-files", "--no-skills", "--no-builtin-tools"]),
        ],
        env: {
          ...(isOwn ? await loginEnvLess([KEY]) : {}),
          BUN_BE_BUN: "1",
          // Each pi loads the extension fresh: jiti's file cache in the shared temporary folder is not shared by the
          // pi processes the desk runs at once.
          JITI_FS_CACHE: "false",
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
          [PI_EXTENSION_ENV.doorKey]: a.door.key,
          [PI_EXTENSION_ENV.doorUrl]: a.door.url,
          [PI_EXTENSION_ENV.facts]: JSON.stringify(readSendFacts()),
          ...(isOwn
            ? {
                [PI_EXTENSION_ENV.hooks]: JSON.stringify(
                  readClaudeHooks(place.claude)
                ),
                [PI_EXTENSION_ENV.own]: "1",
              }
            : {}),
          [PI_EXTENSION_ENV.key]: process.env[KEY] ?? "",
          [PI_EXTENSION_ENV.provider]: JSON.stringify(place.provider),
        },
      };
    },
  };
}

/** What pi prints on stdout, as far as the runtime reads it. */
interface PiLine {
  aborted?: boolean;
  assistantMessageEvent?: { delta?: string; type: string };
  command?: string;
  data?: { commands?: { name: string }[]; disposition?: string };
  error?: string;
  id?: string;
  isError?: boolean;
  message?: {
    errorMessage?: string;
    role: string;
    stopReason?: string;
    usage?: {
      cacheRead: number;
      cacheWrite: number;
      input: number;
      output: number;
      totalTokens: number;
    };
  };
  success?: boolean;
  toolCallId?: string;
  toolName?: string;
  type: string;
}

/** The run in progress on a connection: what it heard so far, and how to settle it. */
interface Current {
  begun: () => void;
  end: (e: RunEnd) => void;
  onUpdate?: (u: Update) => void;
  stop?: string;
  usage: Usage;
  why?: string;
}

/** What a pi line tells the run's listener, if anything. */
function updateOf(l: PiLine): Update | undefined {
  const e = l.assistantMessageEvent?.type ?? "";
  if (l.type === "message_update" && e === "text_delta") {
    return { kind: "words", text: l.assistantMessageEvent?.delta ?? "" };
  }
  if (l.type === "message_update" && e.startsWith("thinking")) {
    return { kind: "thinking" };
  }
  if (l.type === "tool_execution_start" || l.type === "tool_execution_end") {
    const state = l.isError ? "failed" : "completed";
    return {
      id: l.toolCallId ?? "",
      kind: "working",
      state: l.type === "tool_execution_start" ? "in_progress" : state,
      title: l.toolName ?? "",
    };
  }
}

/** Adds one model call's usage to the run's: its tokens, and its whole context as the first and last call saw it. */
function addUsage(u: Usage, m: NonNullable<PiLine["message"]>["usage"]) {
  if (!m) {
    return;
  }
  u.tokensIn += m.input + m.cacheWrite;
  u.tokensCached += m.cacheRead;
  u.tokensOut += m.output;
  u.contextFirst ??= m.totalTokens;
  u.contextLast = m.totalTokens;
}

/** A line pi printed, read as JSON; none when it is not. */
const parseLine = (text: string): PiLine | undefined => {
  try {
    return JSON.parse(text) as PiLine;
  } catch {
    // not a line of pi's protocol
    return undefined;
  }
};

/** What line `l` does to the run `c`: its beginning, its usage and stop, its listener's update; its end at `agent_settled`. */
function runHeard(c: Current, l: PiLine): RunEnd | undefined {
  if (l.type === "message_update") {
    c.begun();
  }
  if (l.type === "message_end" && l.message?.role === "assistant") {
    addUsage(c.usage, l.message.usage);
    c.stop = l.message.stopReason;
    c.why = l.message.errorMessage;
  }
  const heard = updateOf(l);
  if (heard) {
    c.onUpdate?.(heard);
  }
  if (l.type !== "agent_settled") {
    return;
  }
  if (l.aborted) {
    return { ok: false, why: "cancelled" };
  }
  return c.stop === "error" || c.stop === "aborted"
    ? { ok: false, why: c.why ?? c.stop }
    : { ok: true, usage: c.usage };
}

/**
 * Spawns pi in `a.folder` on session `resume` (none: a new one, its id made here) and waits for Life's extension to
 * answer (`PI_EXTENSION_COMMAND` in `get_commands`): within `launchWithin`, else pi is killed and the open fails.
 */
const openOf =
  (row: PiRow, launchWithin: number): Open =>
  async (a, resume, opening) => {
    const ref = resume ?? crypto.randomUUID();
    const { command, env } = await row.spawn(a, ref, !resume);
    const { child, close, exited, stopping } = spawnFor(
      a,
      command,
      env,
      opening
    );
    const answers = new Map<string, (l: PiLine) => void>();
    let current: Current | undefined;
    let asked = 0;
    const send = (line: object) =>
      child.stdin.write(`${JSON.stringify(line)}\n`);
    const ask = (line: { message?: string; type: string }) =>
      new Promise<PiLine>((resolve) => {
        asked += 1;
        const id = `life-${asked}`;
        answers.set(id, resolve);
        send({ ...line, id });
      });
    const settle = (e: RunEnd) => {
      const c = current;
      current = undefined;
      // Logged by its stop reason only, a code word: pi's error message can echo the call.
      if (c && !e.ok) {
        log("desk.runtime", {
          agent: a.id,
          error: c.stop ?? "ended",
          ok: false,
          what: "turn",
        });
      }
      c?.end(e);
    };
    /** One line pi printed: a response to what the runtime asked, else an event of the run. */
    const hear = (text: string) => {
      const l = parseLine(text);
      if (l?.type === "response") {
        answers.get(l.id ?? "")?.(l);
        answers.delete(l.id ?? "");
        return;
      }
      const ended = l && current && runHeard(current, l);
      if (ended) {
        settle(ended);
      }
    };
    // Split on line feeds only (pi's rpc.md): a reader by lines would also split a JSON string at U+2028 or U+2029.
    let rest = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        hear(line.endsWith("\r") ? line.slice(0, -1) : line);
      }
    });
    exited.then(() => settle({ ok: false, why: "pi exited" }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const listed = await Promise.race([
        ask({ type: "get_commands" }),
        exited.then(() => {
          throw new Error("pi exited as it started");
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`pi did not answer within ${launchWithin / 1000} s`)
              ),
            launchWithin
          );
        }),
      ]);
      if (
        !listed.data?.commands?.some((c) => c.name === PI_EXTENSION_COMMAND)
      ) {
        throw new Error(
          "Life's pi extension did not load: no agent runs unguarded"
        );
      }
    } catch (error) {
      child.kill("SIGKILL");
      await close();
      throw error;
    } finally {
      clearTimeout(timer);
    }

    let ended: Promise<RunEnd> | undefined;
    let isPrompted = false;
    const prompt: Connection["prompt"] = (message, onUpdate) => {
      let begun: () => void = () => undefined;
      let notBegun: (e: Error) => void = () => undefined;
      const began = new Promise<void>((ok, fail) => {
        begun = ok;
        notBegun = fail;
      });
      began.catch(() => undefined);
      isPrompted = true;
      ended = new Promise<RunEnd>((end) => {
        current = {
          begun,
          end: (e) => {
            notBegun(new Error(e.why ?? "it ended before the turn began"));
            end(e);
          },
          onUpdate,
          usage: {
            contextFirst: null,
            contextLast: null,
            tokensCached: 0,
            tokensIn: 0,
            tokensOut: 0,
          },
        };
      });
      ask({ message, type: "prompt" }).then((r) => {
        if (r.success === false) {
          settle({ ok: false, why: r.error ?? "pi refused the prompt" });
        }
        // A prompt pi handled itself (an extension's command) starts no run: no `agent_settled` comes.
        if (r.data?.disposition === "handled") {
          settle({ ok: false, why: "pi handled the prompt as a command" });
        }
      });
      return { begun: began, ended };
    };
    const stop = async () => {
      if (!isPrompted) {
        return;
      }
      send({ type: "abort" });
      await stopping(ended);
    };
    return { close, exited, prompt, ref, stop };
  };

/** pi as a runtime: the one runtime (`sessionRuntime`) over pi's RPC. */
export const piRuntime = (
  row: PiRow = piRowOf(),
  launchWithin = LAUNCH_WITHIN_MS,
  keepWarm?: number
): Runtime => sessionRuntime(row, openOf(row, launchWithin), keepWarm);
