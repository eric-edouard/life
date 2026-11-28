import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  IS_COMPILED_HELPER,
  LIFE_CODE_DIR,
  LIFE_STATE_DIR,
  PI_DIR,
} from "../../core/paths";
import { HOME, isOwnLife } from "../../core/platform";
import { exec } from "../../core/proc";
import { SECRETS, writeSecret } from "../../core/secret";
import { settings } from "../../core/settings";
import {
  readOpenSessionRecords,
  TERMINAL_ENTRYPOINT,
  TERMINAL_SESSIONS,
} from "../../host/open-session-records";
import { ASK_EFFORT, piRouteOf } from "../../models/llm";
import { MAX_TOKENS, routingOf } from "../../models/routers";
import { WEB_SEARCH_CHAIN } from "../../web-search/backend";
import type { ClaudeHookGroup } from "./claude-hooks";
import type { Agent, Runtime } from "./contract";
import { type PiRow, piOpenOf } from "./pi-connection";
import { PI_EXTENSION_ENV, PI_PROVIDER, type PiProvider } from "./pi-extension";
import { closeDanglingCalls } from "./pi-session-repair";
import type { PiTerminalLaunch } from "./pi-terminal";
import { providerPause } from "./provider-pause";
import {
  GATED_KEYS,
  loginEnvLess,
  readSendFacts,
  type SessionState,
} from "./runtime-rows";
import { LAUNCH_WITHIN_MS, sessionRuntime } from "./session-runtime";

/** The session file of `ref` under `sessions`, if pi wrote one (`<time>_<ref>.jsonl`). */
const piSessionFileOf = (sessions: string, ref: string) => {
  try {
    const name = new Bun.Glob(`*_${ref}.jsonl`).scanSync(sessions).next().value;
    return name ? join(sessions, name) : undefined;
  } catch {
    // no sessions folder yet
  }
};

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
/** One of Life's files run beside pi: bundled under the app's resources (`scripts/helper.ts`), the source in a checkout. */
const besidePi = (name: string) =>
  ["js", "ts"]
    .map((e) =>
      join(
        LIFE_CODE_DIR,
        "apps",
        "server",
        "src",
        "desk",
        "runtimes",
        `${name}.${e}`
      )
    )
    .find(existsSync);
/** Life's pi extension. */
const PI_EXTENSION = besidePi("pi-extension");
/** Life's Terminal launcher (`pi-terminal.ts`). */
const PI_TERMINAL = besidePi("pi-terminal");
/** How long the Mac has to say pi runs in Terminal (the launcher's record) before the open counts as failed. */
const TERMINAL_WITHIN_MS = 10_000;

/** `w` single-quoted for `sh`, as one word. */
const shellQuoted = (w: string) => `'${w.replaceAll("'", "'\\''")}'`;

/**
 * Opens pi's own interface on a session in a new Terminal window on his Mac (`continueOnMac`): the launch (with Life's
 * part of the environment, a secret) goes to a file only he reads, which the launcher deletes as it reads it; a
 * `.command` file in `dir` runs the launcher, which Terminal opens with no automation permission. Answers once the
 * launcher's record says pi runs; past `TERMINAL_WITHIN_MS`, the launch file is deleted and it throws.
 */
async function openInTerminal(launch: PiTerminalLaunch, dir: string) {
  if (!PI_TERMINAL) {
    throw new Error("Life's Terminal launcher is missing");
  }
  writeSecret("piTerminalLaunch", JSON.stringify(launch));
  const script = join(dir, "continue-on-mac.command");
  const words = [process.execPath, PI_TERMINAL, SECRETS.piTerminalLaunch];
  writeFileSync(
    script,
    `#!/bin/sh\nexec env BUN_BE_BUN=1 ${words.map(shellQuoted).join(" ")}\n`,
    { mode: 0o700 }
  );
  const opened = await exec(["open", "-a", "Terminal", script]);
  for (
    let waited = 0;
    opened.code === 0 && waited < TERMINAL_WITHIN_MS;
    waited += 250
  ) {
    if (readOpenSessionRecords([launch.records]).has(launch.ref)) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: waits for the Mac's word
    await Bun.sleep(250);
  }
  rmSync(SECRETS.piTerminalLaunch, { force: true });
  throw new Error("No answer from your Mac");
}
/** The key pi's provider takes: Life's own, from its environment. */
const KEY = "OPENROUTER_API_KEY";

/** The desk's word for pi's one model (the phone's choice, `RuntimeName.models`): the provider's model, whatever its id. */
const PI_MODEL_WORD = "flash";

/** Where pi keeps the desk's sessions and settings, the provider it asks, and the effort an agent naming none thinks at (`askEffort` when it answers him). */
export interface PiPlace {
  askEffort?: string;
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

/**
 * The share of the model's window past which a turn that ended well compacts its session before it ends
 * (`compactedAfter`): long before the window, where a model grows slow, costly and vague, and between wakes, where
 * nothing is lost (the owner's yes of 22 Nov 2026, `pi-harness-opportunities-2026-11-22.md` item 1: about his 400k on
 * today's window of a million). pi's own trigger, inside a long turn, at twice it (`settingsOf`).
 */
const COMPACT_SHARE = 0.4;

/** pi's default reserve (`compaction.md`): never less, so a small window still compacts as pi would. */
const PI_RESERVE_TOKENS = 16_384;

/** Where a turn's end compacts on a model of `window` tokens (unknown: never at the end, pi's own trigger alone). */
export const compactAtOf = (window: number | undefined) =>
  window ? Math.floor(window * COMPACT_SHARE) : Number.POSITIVE_INFINITY;

/** A model silent this long (no header, no byte) fails its request, which pi's own retry asks again (the v4 plan, bundle C). */
const SILENT_RETRY_MS = 30_000;

/** The settings of Life's agent folder for pi, written whole at each spawn: `window` is the model's context, if known. */
const settingsOf = (
  claude: string | undefined,
  window: number | undefined
) => ({
  ...(window
    ? {
        compaction: {
          reserveTokens: Math.max(
            PI_RESERVE_TOKENS,
            window - 2 * compactAtOf(window)
          ),
        },
      }
    : {}),
  // A repo's own `.pi` never loads (the extension refuses it too): it could rewrite a request.
  defaultProjectTrust: "never",
  extensions: [
    "-builtin:codemode",
    "-builtin:tool-search",
    "-builtin:llama.cpp",
  ],
  httpIdleTimeoutMs: SILENT_RETRY_MS,
  quietStartup: true,
  // Life's own skills (the engineering playbook), then his where Claude Code reads them, beside `~/.agents/skills`, which
  // pi reads itself.
  skills: [
    join(LIFE_CODE_DIR, "skills"),
    ...(claude ? [join(claude, "skills")] : []),
  ],
});

/** His Claude folder, where Claude Code reads his instructions and hooks (a test passes its own). */
const CLAUDE_HOME = join(HOME, ".claude");

/** A file's text, or none when it is not there. */
const readTextIfThere = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // not there: none
  }
};

/** What Life's reader of the connector needs from the desk's own environment beside Life's paths: the secrets its reads use and the test switch. */
const READER_ENV = ["GOG_KEYRING_PASSWORD", "LIFELOG_TOKEN", "NODE_ENV"];

const LEADING_BANG = /^!/;

/** Values as pi passes them on untouched (`$` doubled, a leading `!` escaped): pi resolves `$NAME` and runs `!command`. */
const escapedOf = (env: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).map(([k, v]) => [
      k,
      v.replaceAll("$", "$$$$").replace(LEADING_BANG, "$$!"),
    ])
  );

/**
 * The connector's reads as a stdio MCP server (`life connector-reads`): the compiled helper itself in the app, the CLI's
 * entry in a checkout, with Life's paths (`LIFE_*`) and the secrets its reads use. pi runs it with its own environment
 * beside this one, so the helper is told it is not bun (`BUN_BE_BUN`).
 */
export const connectorReadsOf = () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] =>
        e[1] !== undefined &&
        (e[0].startsWith("LIFE_") || READER_ENV.includes(e[0]))
    )
  );
  return {
    args: [
      ...(IS_COMPILED_HELPER
        ? []
        : [
            join(
              LIFE_CODE_DIR,
              "apps",
              "server",
              "src",
              "desk",
              "life-entry.ts"
            ),
          ]),
      "connector-reads",
    ],
    command: process.execPath,
    // Life's state, never the agent's folder: bun reads a folder's `.env` and `bunfig.toml` at start.
    cwd: LIFE_STATE_DIR,
    // pi reads `$NAME` and a leading `!` in an MCP entry's values: each value escaped, so it reaches the reader as is.
    env: { ...escapedOf(env), BUN_BE_BUN: "" },
  };
};

/** How deep `@` imports are followed, as Claude Code follows them. */
const IMPORT_DEPTH = 5;
/** A line that is an `@` import: the path it names. */
const IMPORT_LINE = /^@(\S+)$/;

/** `file`'s text, each line that is an `@` import replaced by the file it names (from `file`'s folder, `~/` from home). */
function readWithImports(file: string, depth: number): string | undefined {
  return readTextIfThere(file)
    ?.split("\n")
    .map((l) => {
      const at = IMPORT_LINE.exec(l.trim())?.[1];
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

/**
 * pi's row for his own Life, or a second Life's (`isOwn` false: no login environment, context file, skill or built-in
 * tool). `place` is where its sessions and settings live and the provider it asks (a test passes its own).
 */
export function piRowOf(
  isOwn = isOwnLife(),
  place: PiPlace = {
    askEffort: ASK_EFFORT,
    claude: CLAUDE_HOME,
    dir: PI_DIR,
    effort: piRouteOf().effort,
    provider: lifeProviderOf(),
  }
): PiRow {
  const sessions = join(place.dir, "sessions");
  const agentDir = join(place.dir, "agent");
  const [model] = place.provider.models ?? [];
  /** What agent `a`'s run on session `ref` needs (the session file to resume, its model and effort), or why it can't run. */
  const runOf = (a: Agent, ref: string, isNew: boolean, isAsk = false) => {
    if (!(PI_EXTENSION && model)) {
      throw new Error("Life's pi extension or its model is missing");
    }
    if (a.model && a.model !== PI_MODEL_WORD) {
      throw new Error(
        `pi runs its one model (${PI_MODEL_WORD}), not ${a.model}`
      );
    }
    const file = isNew ? undefined : piSessionFileOf(sessions, ref);
    if (!(isNew || file)) {
      throw new Error(`pi has no session ${ref}`);
    }
    if (file) {
      closeDanglingCalls(file);
    }
    return {
      effort: a.effort ?? (isAsk ? place.askEffort : place.effort),
      extension: PI_EXTENSION,
      file,
      id: model.id,
      window: "contextWindow" in model ? model.contextWindow : undefined,
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
    continueOnMac: isOwn
      ? async (a, ref) => {
          const run = runOfMode(a, ref, false, false);
          const launch: PiTerminalLaunch = {
            command: run.command,
            drop: [KEY, ...GATED_KEYS],
            entrypoint: TERMINAL_ENTRYPOINT,
            env: run.env,
            file: run.file ?? "",
            folder: a.folder,
            records: TERMINAL_SESSIONS,
            ref,
          };
          await openInTerminal(launch, place.dir);
        }
      : undefined,
    // pi has no app to open: its session stays in pi's own file on the Mac.
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
      return piSessionFileOf(sessions, ref) ? "idle" : "gone";
    },
    async spawn(a, ref, isNew, isAsk) {
      const run = runOfMode(a, ref, isNew, true, isAsk);
      return {
        command: run.command,
        compactAt: compactAtOf(run.window),
        env: { ...(isOwn ? await loginEnvLess([KEY]) : {}), ...run.env },
        inForceFile: run.inForceFile,
      };
    },
  };
  /**
   * The command of agent `a`'s pi on session `ref` and Life's part of its environment (his own Life's run adds his login
   * environment less the engine's key): the desk's turn in pi's RPC mode (`isRpc`), else pi's own interface, in Terminal.
   */
  function runOfMode(
    a: Agent,
    ref: string,
    isNew: boolean,
    isRpc: boolean,
    isAsk = false
  ) {
    const { effort, extension, file, id, window } = runOf(a, ref, isNew, isAsk);
    mkdirSync(agentDir, { recursive: true });
    const inForceFile = join(place.dir, "in-force", `${ref}.md`);
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify(settingsOf(isOwn ? place.claude : undefined, window))
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
        ...(isRpc ? ["--mode", "rpc"] : []),
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
          : // Its door's tools alone: no built-in tool, no extension tool (`web_fetch`, `subagent`).
            ["--no-context-files", "--no-skills", "--tools", "mcp__desk__*"]),
      ],
      env: {
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
        [PI_EXTENSION_ENV.inForce]: inForceFile,
        ...(isOwn
          ? {
              [PI_EXTENSION_ENV.hooks]: JSON.stringify(
                readClaudeHooks(place.claude)
              ),
              [PI_EXTENSION_ENV.own]: "1",
              [PI_EXTENSION_ENV.reads]: JSON.stringify(connectorReadsOf()),
              [PI_EXTENSION_ENV.search]: JSON.stringify(
                settings().desk?.webSearch ?? WEB_SEARCH_CHAIN
              ),
            }
          : {}),
        [PI_EXTENSION_ENV.key]: process.env[KEY] ?? "",
        [PI_EXTENSION_ENV.provider]: JSON.stringify(place.provider),
        ...(a.rules ? { [PI_EXTENSION_ENV.rules]: a.rules } : {}),
      },
      file,
      inForceFile,
      window,
    };
  }
}

/** pi as a runtime: the one runtime (`sessionRuntime`) over pi's RPC. */
export const piRuntime = (
  row: PiRow = piRowOf(),
  launchWithin = LAUNCH_WITHIN_MS,
  keepWarm?: number
): Runtime => {
  const pause = providerPause();
  return {
    ...sessionRuntime(row, piOpenOf(row, launchWithin, pause), keepWarm),
    paused: pause.block,
    // Life's extension holds an agent's rules as a section of every run's system prompt (`pi-extension.ts`).
    pinsRules: true,
  };
};
