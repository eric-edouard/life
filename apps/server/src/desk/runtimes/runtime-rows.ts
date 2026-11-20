import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clock, MIN } from "../../core/clock";
import { linesOf } from "../../core/files";
import { log } from "../../core/log";
import type { RuntimeName } from "../../core/names";
import { LIFE_CODE_DIR } from "../../core/paths";
import { cliEnv, HOME, isOwnLife, WINDOWS } from "../../core/platform";
import { exec, firstLine, readLoginEnv } from "../../core/proc";
import { settings } from "../../core/settings";
import { mailedTo } from "../../host/report";
import { CODEX_AGENT_OFF, CODEX_HOME, CODEX_OFF } from "../../models/llm";
import { readMailAddresses } from "../../sources/mail";
import { SEND_GUARD_HOOK, type SendFacts } from "../send-guard";
import type { Agent } from "./contract";

// The runtime rows: each runtime's own facts, the one place they live (`acp-runtime.ts` names no runtime). A row is its
// pinned ACP adapter's command, env and session `_meta`, the config ids of its model and effort, its no-ask mode, the
// prefix its door's tools carry (a second Life's only), its link, its hand-off, and the small reader of its CLI's own record that tells whether a session of his
// is running (ACP has no such signal). The adapters are pinned; the CLIs stay his (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`):
// his apps open these sessions, so the same CLI writes them.
// An agent of his own Life is held back by nothing but the send guard (his decisions of 19 and 20 Nov 2026): his settings,
// rules, skills and connectors, his login shell's environment (`readLoginEnv`) less the runtime's own engine keys, the
// runtime's no-ask mode, and every permission ask approved; the guard (`send-guard.ts`) runs before each shell and MCP
// call, a hook of the session's own flags, never written into his config. A second Life's agent (a demo, `isOwnLife` false) runs apart from his setup,
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
  /** The session's `_meta` for `session/new` and `session/resume`, for agent `a`. */
  meta?: (a: Agent) => Record<string, unknown>;
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

// ---- the send guard

/** The guard's script: bundled under the app's resources (`scripts/helper.ts`), the source in a checkout. */
const SEND_GUARD = ["js", "ts"]
  .map((e) =>
    join(LIFE_CODE_DIR, "apps", "server", "src", "desk", `send-guard-hook.${e}`)
  )
  .find(existsSync);

/** The guard's hook entry, as both runtimes' settings take it. */
const GUARD_HOOKS = {
  PreToolUse: [
    {
      hooks: [{ command: SEND_GUARD_HOOK.command, type: "command" }],
      matcher: SEND_GUARD_HOOK.matcher,
    },
  ],
};

/** His own addresses, as Mail knows them, and Life's mail to him: none when Mail can't be read (resend then goes nowhere). */
function readOwnAddresses() {
  const to = mailedTo();
  try {
    return [...readMailAddresses(), ...(to ? [to] : [])];
  } catch (e) {
    log("desk.runtime", { error: String(e), ok: false, what: "send facts" });
    return to ? [to] : [];
  }
}

/** The environment the guard's hook reads (`send-guard-hook.ts`), read at each spawn. Throws with no script: no agent starts unguarded. */
function guardEnv() {
  if (!SEND_GUARD) {
    throw new Error("Life's send guard is missing: no agent starts unguarded");
  }
  return {
    LIFE_BUN: process.execPath,
    LIFE_SEND_FACTS: JSON.stringify({
      ownAddresses: readOwnAddresses(),
      postRepos: settings().desk?.agentPostRepos ?? [],
    } satisfies SendFacts),
    LIFE_SEND_GUARD: SEND_GUARD,
  };
}

const CODEX_GUARD_KEY = "/<session-flags>/config.toml:pre_tool_use:0:0";
const codexTrust = new Map<string, Promise<Record<string, unknown>>>();

/** `hooks/list`'s answer, as far as the guard reads it. */
interface HookList {
  result?: { data?: { hooks?: { currentHash?: string; key?: string }[] }[] };
}

/**
 * The trust Codex needs to run the guard, a hook of the session's flags: the hash `program` gives it (`hooks/list` of
 * its app server, asked once per process), as `hooks.state`. Throws when it gives none: no agent runs unguarded.
 */
export function readCodexGuardTrust(program: string, env = cliEnv()) {
  const asked = codexTrust.get(program);
  if (asked) {
    return asked;
  }
  const trust = (async () => {
    const { command, matcher } = SEND_GUARD_HOOK;
    const hooks = `{PreToolUse=[{matcher=${JSON.stringify(matcher)},hooks=[{type="command",command=${JSON.stringify(command)}}]}]}`;
    const line = await firstLine(
      [program, "app-server", "-c", `hooks=${hooks}`],
      [
        {
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "life", version: "0" } },
        },
        { method: "initialized" },
        { id: 2, method: "hooks/list", params: { cwds: [HOME] } },
      ]
        .map((m) => `${JSON.stringify(m)}\n`)
        .join(""),
      (l) => l.includes('"id":2'),
      { env, timeout: 30_000 }
    );
    const hash = (JSON.parse(line ?? "{}") as HookList).result?.data
      ?.flatMap((d) => d.hooks ?? [])
      .find((h) => h.key === CODEX_GUARD_KEY)?.currentHash;
    if (!hash) {
      codexTrust.delete(program);
      throw new Error(
        "Codex gave no hash for Life's send guard: no agent starts unguarded"
      );
    }
    return { [CODEX_GUARD_KEY]: { trusted_hash: hash } };
  })();
  codexTrust.set(program, trust);
  return trust;
}

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
      code: r.code,
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
  // Every session of an agent, the fresh ones too, carries its title as its name in his app's list (`--name`).
  meta: (a) => ({
    claudeCode: {
      options: {
        extraArgs: { name: a.title },
        ...(isOwn
          ? { settings: { hooks: GUARD_HOOKS } }
          : {
              allowedTools: ["mcp__desk"],
              permissionMode: "default",
              settingSources: [],
              strictMcpConfig: true,
              tools: [],
            }),
      },
    },
  }),
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
        ...(isOwn ? guardEnv() : {}),
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
      const program = readProgram("codex");
      // The model and effort also go in at spawn: switching them after the session starts costs a turn's tokens.
      const config = {
        ...(isOwn
          ? {
              hooks: {
                ...GUARD_HOOKS,
                state: await readCodexGuardTrust(program),
              },
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
          ...(isOwn ? guardEnv() : {}),
          CODEX_CONFIG: JSON.stringify(config),
          CODEX_PATH: program,
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
