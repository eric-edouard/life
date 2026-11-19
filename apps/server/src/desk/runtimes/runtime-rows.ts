import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clock, MIN } from "../../core/clock";
import { linesOf } from "../../core/files";
import { log } from "../../core/log";
import type { RuntimeName } from "../../core/names";
import { LIFE_CODE_DIR } from "../../core/paths";
import { cliEnv, HOME, isOwnLife, WINDOWS } from "../../core/platform";
import { exec, readLoginEnv } from "../../core/proc";
import { CODEX_AGENT_OFF, CODEX_HOME, CODEX_OFF } from "../../models/llm";
import type { Agent } from "./contract";

// The runtime rows: each runtime's own facts, the one place they live (`acp-runtime.ts` names no runtime). A row is its
// pinned ACP adapter's command, env and session `_meta`, the config ids of its model and effort, its no-ask mode, the
// prefix its door's tools carry (a second Life's only), its link, its hand-off, and the small reader of its CLI's own record that tells whether a session of his
// is running (ACP has no such signal). The adapters are pinned; the CLIs stay his (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`):
// his apps open these sessions, so the same CLI writes them.
// An agent of his own Life is held back by nothing (his decision of 19 Nov 2026): his settings, rules, skills and
// connectors, his login shell's environment (`readLoginEnv`) less the runtime's own engine keys, the runtime's no-ask
// mode, and every permission ask approved. A second Life's agent (a demo, `isOwnLife` false) runs apart from his setup,
// since his connectors and files reach his own Life: its door alone, none of his settings, rules, MCP servers, sessions
// or environment, and never handed to his apps.
// ponytail: his own turn in the Claude or Codex app starts no process of the desk's: Claude's counts as running while a
// process holds the session and the transcript's last turn is open, Codex's while the rollout's last turn is open and
// was written in the last 10 minutes (`isOpenNow`), so a tool call silent for longer reads idle and the desk may send
// beside it. And an app holding a session open while idle keeps its own copy: his next message there may continue from
// it, missing the desk's turn (the same for Claude's warm process).

export type SessionState = "running" | "idle" | "gone";

export interface Row {
  /** Why the program can't run now: `Runtime.block`. */
  block: () => Promise<string | undefined>;
  /** The ids of the session's model and effort options (`session/set_config_option`). */
  config: { effort: string; model: string };
  /** Opens a first turn's session in his app once no process holds it; none: the app lists it unasked. */
  handOff?: (a: Agent, ref: string) => Promise<void>;
  /** The door's `Authorization` value for `key`: Claude puts the key in its adapter's env and sends the literal `${LIFE_DESK_KEY}`, which it expands. */
  header: (key: string) => string;
  /** A link that opens session `ref` in his app. */
  link: (ref: string) => string;
  /** The session's `_meta` for `session/new` and `session/resume`. */
  meta?: Record<string, unknown>;
  /** The runtime's no-ask mode, set after every `session/new` and `session/resume` (`session/set_config_option`, id `mode`); none: the session's own. */
  mode?: string;
  /** A second Life's row only: what the title of a door tool's call starts with, the only tools the desk's client approves. None: every ask is approved. */
  onlyDoorPrefix?: string;
  /** Whether the session runs a turn of his now, from its CLI's own record, when the desk runs none. */
  readSessionState: (ref: string) => Promise<SessionState>;
  /** The adapter's command and env (besides `cliEnv`) for `a`'s turn. */
  spawn: (
    a: Agent
  ) => Promise<{ command: string[]; env: Record<string, string> }>;
}

/**
 * The program the desk launches for a CLI: found on the PATH as it is now (`cliEnv`), less any `node_modules/.bin` (where
 * `bun run` puts Life's own pinned Codex, which is not his); the bare name when none is found.
 */
export function readProgram(name: string) {
  const path = (cliEnv().PATH ?? "")
    .split(":")
    .filter((d) => !d.endsWith("node_modules/.bin"))
    .join(":");
  return Bun.which(name, { PATH: path }) ?? name;
}

/** `Runtime.block` for a CLI: why `<program> --version` fails, none when it answers. */
export async function readCliBlock(program: string) {
  const r = await exec([readProgram(program), "--version"], {
    env: cliEnv(),
    timeout: 5000,
  });
  return r.code === 0
    ? undefined
    : `${program} --version failed: ${r.stderr.slice(-200) || r.code}`;
}

/** Whether some process holds session `ref` (its id is in the command line): the desk's turn, his, or an app's warm one. */
export async function isHeld(ref: string) {
  const { code, stderr } = await exec(["pgrep", "-f", ref]);
  // 1: no process; anything else (-1: pgrep could not start) is no answer, never "free".
  if (code !== 0 && code !== 1) {
    throw new Error(`pgrep: ${stderr}`);
  }
  return code === 0;
}

/**
 * An adapter's command: the pinned package's file, run by `bun` (in a checkout) or by the compiled helper itself
 * (`BUN_BE_BUN`), since the adapters are Node scripts and the app has no node. `scripts/helper.ts` puts a bundle of each at
 * the same path under the app's resources.
 */
const adapterOf = (name: string) => ({
  command: [
    process.execPath,
    join(
      LIFE_CODE_DIR,
      "node_modules",
      "@agentclientprotocol",
      name,
      "dist",
      "index.js"
    ),
  ],
  env: { BUN_BE_BUN: "1" },
});

// ---- claude

const PROJECTS = join(HOME, ".claude", "projects");

/** The session's transcript's path, if Claude wrote one. */
const transcriptOf = (ref: string) => {
  const path = new Bun.Glob(`*/${ref}.jsonl`).scanSync(PROJECTS).next().value;
  return path ? join(PROJECTS, path) : undefined;
};

/** The session's transcript, if Claude wrote one. */
const readTranscript = (ref: string) => {
  const path = transcriptOf(ref);
  try {
    return path ? readFileSync(path, "utf8") : undefined;
  } catch {
    // gone between the glob and the read
  }
};

interface Entry {
  isSidechain?: boolean;
  message?: { content?: unknown; stop_reason?: string | null };
  type?: string;
}

/** A transcript's entries of the main conversation (a subagent's are sidechain). */
const entriesOf = (lines: string) =>
  lines
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Entry)
    .filter((e) => !e.isSidechain);

/** His interrupt, which ends a turn with no answer. */
const isInterrupt = (e: Entry) =>
  e.type === "user" &&
  JSON.stringify(e.message?.content ?? "").includes(
    "[Request interrupted by user"
  );

/**
 * Whether a transcript's last turn is still open: its last message is not a finished answer (an assistant message that
 * stopped for a reason other than a tool call) nor his interrupt. A message with no stop reason yet, or a line still
 * being written, counts as open.
 */
export function isTurnOpen(lines: string) {
  let last: Entry | undefined;
  try {
    last = entriesOf(lines).findLast(
      (e) => e.type === "user" || e.type === "assistant"
    );
  } catch {
    return true;
  }
  const stop = last?.message?.stop_reason;
  const isAnswer = last?.type === "assistant" && !!stop && stop !== "tool_use";
  return !!last && !(isAnswer || isInterrupt(last));
}

/**
 * Opens session `ref` in the Claude app, so its link works: once no process runs it (the CLI refuses while one does),
 * under a pseudo-terminal (it refuses without one). It lists the session in the app, which keeps a process warm for it.
 */
async function handOff(a: Agent, ref: string) {
  const r = await exec(
    [
      "script",
      "-q",
      "/dev/null",
      readProgram("claude"),
      "--desktop",
      "--resume",
      ref,
    ],
    { cwd: a.folder, timeout: 30_000 }
  );
  if (r.code !== 0) {
    log("desk.runtime", {
      agent: a.id,
      error: r.stdout.slice(-300),
      ok: false,
      what: "link",
    });
  }
}

/**
 * His login environment for an agent of his own Life, less `engine`'s keys: passed through, they would move the agent from
 * his subscription to paid API billing.
 */
const loginEnvLess = async (engine: string[]) =>
  Object.fromEntries(
    Object.entries(await readLoginEnv()).filter(([k]) => !engine.includes(k))
  );

/**
 * His own Life's agent: his settings, rules, skills and connectors as any session of his, in the no-ask mode. A second
 * Life's agent: none of his settings (hooks, plugins, permissions), no MCP server but the door, no built-in tool
 * (no shell, no file), the door's tools allowed and the mode explicit; none of his CLAUDE.md or memory.
 */
const claudeRow = (isOwn: boolean): Row => ({
  block: () => readCliBlock("claude"),
  config: { effort: "effort", model: "model" },
  // ponytail: the Claude app's hand-off is the Mac's; a Windows link waits for a Windows install.
  handOff: isOwn && !WINDOWS ? handOff : undefined,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude expands it from the adapter's environment
  header: () => "Bearer ${LIFE_DESK_KEY}",
  link: (ref) => `claude://claude.ai/epitaxy/local_${ref}`,
  meta: isOwn
    ? undefined
    : {
        claudeCode: {
          options: {
            allowedTools: ["mcp__desk"],
            permissionMode: "default",
            settingSources: [],
            strictMcpConfig: true,
            tools: [],
          },
        },
      },
  mode: isOwn ? "bypassPermissions" : undefined,
  onlyDoorPrefix: isOwn ? undefined : "mcp__desk__",
  async readSessionState(ref) {
    const lines = readTranscript(ref);
    if (
      (await isHeld(ref)) &&
      // No transcript yet: the process alone says.
      (lines === undefined || isTurnOpen(lines))
    ) {
      return "running";
    }
    return lines === undefined ? "gone" : "idle";
  },
  spawn: async (a) => {
    const adapter = adapterOf("claude-agent-acp");
    return {
      command: adapter.command,
      env: {
        ...(isOwn
          ? await loginEnvLess([
              "ANTHROPIC_API_KEY",
              "ANTHROPIC_AUTH_TOKEN",
              "ANTHROPIC_BASE_URL",
            ])
          : {}),
        ...adapter.env,
        CLAUDE_CODE_EXECUTABLE: readProgram("claude"),
        LIFE_DESK_KEY: a.door.key,
        ...(isOwn
          ? {}
          : {
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
              CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
            }),
      },
    };
  },
});

// ---- codex

/** How long a rollout's open turn counts as his running turn, written to or not. */
const OPEN_FOR = 10 * MIN;

/** Whether a rollout's last turn is open: `task_started` is the last of its turn events (a killed turn leaves one open). */
export const isRolloutTurnOpen = (lines: string[]) =>
  lines
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as { payload?: { type?: string } }];
      } catch {
        return [];
      }
    })
    .findLast((e) =>
      ["task_started", "task_complete", "turn_aborted"].includes(
        e.payload?.type ?? ""
      )
    )?.payload?.type === "task_started";

/**
 * His own Life's agent: his `~/.codex` and his shell's environment for the commands it runs. A second Life's agent: Life's own Codex home (a login of its own, as Life's model engine; none of his AGENTS.md,
 * config, MCP servers or sessions), no instruction file of its folder, no skill, web search or extra, no shell. The
 * adapter can't pass `--ignore-user-config` or `--ignore-rules`: that home's config and rules apply, and they are Life's.
 */
const SECOND_LIFE_CODEX = {
  features: Object.fromEntries(
    [...CODEX_OFF, ...CODEX_AGENT_OFF].map((f) => [f, false])
  ),
  project_doc_max_bytes: 0,
  skills: { bundled: { enabled: false }, include_instructions: false },
  web_search: "disabled",
};

const codexRow = (isOwn: boolean): Row => {
  const home = isOwn ? join(HOME, ".codex") : CODEX_HOME;
  /** The session's rollout, plain or compressed (Codex compresses idle ones), if Codex has one. */
  const rolloutOf = (ref: string) => {
    try {
      return new Bun.Glob(`*/*/*/rollout-*-${ref}.jsonl{,.zst}`)
        .scanSync(join(home, "sessions"))
        .next().value;
    } catch {
      // no sessions folder yet
    }
  };
  /** A rollout's complete lines. */
  const rolloutLines = (path: string) => {
    const file = join(home, "sessions", path);
    if (!path.endsWith(".zst")) {
      return linesOf(file);
    }
    const lines = new TextDecoder()
      .decode(Bun.zstdDecompressSync(readFileSync(file)))
      .split("\n");
    lines.pop();
    return lines;
  };
  /** Whether the rollout holds his running turn: open and written to within `OPEN_FOR`. A file gone or being rewritten is not. */
  const isOpenNow = (path: string) => {
    try {
      return (
        clock().getTime() - statSync(join(home, "sessions", path)).mtimeMs <
          OPEN_FOR && isRolloutTurnOpen(rolloutLines(path))
      );
    } catch {
      return false;
    }
  };
  return {
    block: () => readCliBlock("codex"),
    config: { effort: "reasoning_effort", model: "model" },
    header: (key) => `Bearer ${key}`,
    link: (ref) => `codex://threads/${ref}`,
    onlyDoorPrefix: isOwn ? undefined : "mcp.desk.",
    readSessionState(ref) {
      const path = rolloutOf(ref);
      if (!path) {
        return Promise.resolve("gone");
      }
      return Promise.resolve(isOpenNow(path) ? "running" : "idle");
    },
    spawn: async (a) => {
      const adapter = adapterOf("codex-acp");
      // The model and effort also go in at spawn: switching them after the session starts costs a turn's tokens.
      const config = {
        ...(isOwn
          ? {
              shell_environment_policy: {
                ignore_default_excludes: true,
                inherit: "all",
              },
            }
          : SECOND_LIFE_CODEX),
        ...(a.model ? { model: a.model } : {}),
        ...(a.effort ? { model_reasoning_effort: a.effort } : {}),
      };
      return {
        command: adapter.command,
        env: {
          ...(isOwn
            ? await loginEnvLess(["CODEX_API_KEY", "OPENAI_API_KEY"])
            : {}),
          ...adapter.env,
          CODEX_CONFIG: JSON.stringify(config),
          CODEX_PATH: readProgram("codex"),
          // His own Life's agent starts in full access (nothing asks); a second Life's in workspace-write, where door calls
          // arrive as permission requests that Life's client answers (read-only cancels them).
          INITIAL_AGENT_MODE: isOwn ? "agent-full-access" : "workspace-write",
          NO_BROWSER: "1",
          ...(isOwn ? {} : { CODEX_HOME }),
        },
      };
    },
  };
};

/** The runtimes' rows, by name: his own Life's, or a second Life's (`isOwn` false), whose isolation is data. */
export const runtimeRowsOf = (
  isOwn = isOwnLife()
): Record<RuntimeName, Row> => ({
  claude: claudeRow(isOwn),
  codex: codexRow(isOwn),
});
