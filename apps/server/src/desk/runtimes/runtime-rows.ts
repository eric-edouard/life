import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { APIFY_KEY_ENV } from "../../apify/backend";
import { clock, MIN } from "../../core/clock";
import { linesOf } from "../../core/files";
import { log } from "../../core/log";
import { errorOf } from "../../core/log-line";
import type { RuntimeName } from "../../core/names";
import { LIFE_CODE_DIR } from "../../core/paths";
import { cliEnv, HOME, isOwnLife, WINDOWS } from "../../core/platform";
import { exec, firstLine, readLoginEnv, readProgram } from "../../core/proc";
import { settings } from "../../core/settings";
import { readOpenSessionRecords } from "../../host/open-session-records";
import { mailedTo } from "../../host/report";
import { CODEX_AGENT_OFF, CODEX_HOME, CODEX_OFF } from "../../models/llm";
import { readMailAddresses } from "../../sources/mail";
import { SEND_FACTS_ENV, SEND_GUARD_HOOK, type SendFacts } from "../send-guard";
import { type Agent, DOOR_KEY_ENV, READS_SERVER } from "./contract";
import { connectorReadsOf, isSecondLifeReading } from "./session-runtime";

// The runtime rows: each runtime's own facts, the one place they live (`acp-runtime.ts` names no runtime). A row is its
// pinned ACP adapter's command, env and session `_meta`, the config ids of its model and effort, its no-ask mode, the
// prefixes of the only tools approved (a second Life's: its door's, and a frozen copy's reads), its link and the small reader of its CLI's own record that tells whether a session of his
// is running (ACP has no such signal). The adapters are pinned; the CLIs stay his (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`):
// his apps open these sessions, so the same CLI writes them.
// An agent of his own Life is held back by nothing but the send guard (his decisions of 19 and 20 Nov 2026): his settings,
// rules, skills and connectors, his login shell's environment (`readLoginEnv`) less the runtime's own engine keys, the
// runtime's no-ask mode, and every permission ask approved; the guard (`send-guard.ts`) runs before each shell and MCP
// call, a hook of the session's own flags, never written into his config. A second Life's agent (a demo, `isOwnLife` false) runs apart from his setup,
// since his connectors and files reach his own Life: its door alone (a frozen copy's, also the connector's reads of
// that copy, `isSecondLifeReading`, their secrets in the adapter's environment), none of his settings, rules, MCP servers,
// sessions or environment, and never handed to his apps.
// ponytail: his own use of a session in the Claude or Codex app starts no process of the desk's: Claude's counts as running
// while any process runs the CLI on it (the app keeps one while he has the session open, between his turns too, so a
// session he left open holds its agent's wakes until the app lets that process go); Codex's app runs no process per
// session, so Codex's counts as running while the rollout's last turn is open and was written in the last 10 minutes
// (`isOpenNow`): a tool call silent for longer, or the app open between his turns, reads idle and the desk may send
// beside it.

export type SessionState = "running" | "idle" | "gone";

export interface Row {
  /** Why the program can't run now: `Runtime.block`. */
  block: () => Promise<string | undefined>;
  /** The ids of the session's model and effort options (`session/set_config_option`). */
  config: { effort: string; model: string };
  /** `Runtime.continueOnMac`. */
  continueOnMac?: (a: Agent, ref: string) => Promise<void>;
  /** The door's `Authorization` value for `key`: Claude puts the key in its adapter's env (`DOOR_KEY_ENV`) and sends that variable's name, which it expands. */
  header: (key: string) => string;
  /** A link that opens session `ref` in his app. */
  link: (ref: string) => string;
  /** Lists a fresh session in his app, once, after Life's process lets it go (`sessionRuntime`); never throws. None: his app lists none. */
  listInApp?: (a: Agent, ref: string) => Promise<void>;
  /** The session's `_meta` for `session/new` and `session/resume`, for agent `a`. */
  meta?: (a: Agent) => Record<string, unknown>;
  /** The runtime's no-ask mode, set after every `session/new` and `session/resume` (`session/set_config_option`, id `mode`); none: the session's own. */
  mode?: string;
  /**
   * A second Life's row only: what the title of an allowed tool's call starts with (its door's, the connector reads'),
   * the only tools the desk's client approves; such a row's session gets the connector reads beside its door. None: every
   * ask is approved.
   */
  onlyToolPrefixes?: string[];
  /** Whether the session runs a turn of his now, from its CLI's own record, when the desk runs none. */
  readSessionState: (ref: string) => Promise<SessionState>;
  /** The adapter's command and env (besides `cliEnv`) for `a`'s turn. */
  spawn: (
    a: Agent
  ) => Promise<{ command: string[]; env: Record<string, string> }>;
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

/**
 * Whether a process runs Claude on session `ref`: Claude's own record names a live one (his app, a terminal or the
 * desk's own run, between his turns too, however it was opened; `readOpenSessionRecords`), or a Claude command line
 * names it after a resume or session flag. A child naming the id only in a path (a dev server under its scratchpad) is neither.
 * ponytail: a record left by a crash whose pid is reused holds the session until that process ends (a wait, never a loss).
 */
export async function isSessionOpen(ref: string) {
  if (readOpenSessionRecords().has(ref)) {
    return true;
  }
  const { code, stderr } = await exec([
    "pgrep",
    "-f",
    `claude.*(--resume|--session-id|-r)[= ]${ref}`,
  ]);
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
    log("desk.runtime", { ...errorOf(e), ok: false, what: "send facts" });
    return to ? [to] : [];
  }
}

/** What the guard reads beside a call (`SendFacts`): the hook's environment at each spawn, the door's `/guard`. */
export const readSendFacts = (): SendFacts => ({
  ownAddresses: readOwnAddresses(),
  postRepos: settings().desk?.agentPostRepos ?? [],
});

/** The environment the guard's hook reads (`send-guard-hook.ts`), read at each spawn. Throws with no script: no agent starts unguarded. */
function guardEnv() {
  if (!SEND_GUARD) {
    throw new Error("Life's send guard is missing: no agent starts unguarded");
  }
  return {
    LIFE_BUN: process.execPath,
    [SEND_FACTS_ENV]: JSON.stringify(readSendFacts()),
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

/** Keys Life holds behind his yes (his word of 22 Nov 2026): an agent reaches their service only through a card he answered. */
export const GATED_KEYS = [APIFY_KEY_ENV];

/** Opens his Claude app (`desk.claudeApp`) on session `ref` by its own import of a CLI session (`claude://resume`), in front or not: `open`'s exit code. */
const openInClaudeApp = async (ref: string, isInFront: boolean) =>
  (
    await exec([
      "open",
      ...(isInFront ? [] : ["-g"]),
      "-a",
      settings().desk?.claudeApp ?? "/Applications/Claude.app",
      `claude://resume?session=${ref}`,
    ])
  ).code;

/**
 * `continue_on_mac`: his Claude app in front on session `ref`. Typing there makes the app keep a process on it, which holds
 * the desk's wakes (`isSessionOpen`) until he leaves it (`takeBackIfLeft`).
 */
async function continueInClaudeApp(_: Agent, ref: string) {
  if ((await openInClaudeApp(ref, true)) !== 0) {
    throw new Error("No answer from your Mac");
  }
}

/**
 * Lists session `ref` in his Claude app's sidebar, in the background (his ask of 26 Nov 2026: "I still want all of the
 * agents to appear in the sidebar"), once its transcript exists. The import starts no process (checked live, 26 Nov
 * 2026); only his typing there does, which the desk's session-open rule and take-back handle (the 22 Nov freeze held
 * wakes with no take-back yet). Never throws: a failure is logged.
 */
async function listInClaudeApp(a: Agent, ref: string) {
  if (!transcriptOf(ref)) {
    return;
  }
  const code = await openInClaudeApp(ref, false);
  if (code !== 0) {
    log("desk.runtime", { agent: a.id, code, ok: false, what: "list" });
  }
}

/**
 * His login environment for an agent of his own Life, less `engine`'s keys (passed through, they would move the agent
 * from his subscription to paid API billing) and the gated keys (`GATED_KEYS`).
 */
export const loginEnvLess = async (engine: string[]) =>
  Object.fromEntries(
    Object.entries(await readLoginEnv()).filter(
      ([k]) => !(engine.includes(k) || GATED_KEYS.includes(k))
    )
  );

/**
 * His own Life's agent: his settings, rules, skills and connectors as any session of his, in the no-ask mode. A second
 * Life's agent: none of his settings (hooks, plugins, permissions), no MCP server but the door and the connector reads
 * over its own Life, no built-in tool (no shell, no file), those tools allowed and the mode explicit; none of his
 * CLAUDE.md or memory, no traffic but its turns', sent to `ANTHROPIC_BASE_URL` when one is set (a question case's
 * replay, `scripts/model-replay.ts`).
 */
const claudeRow = (isOwn: boolean): Row => ({
  block: () => readCliBlock("claude"),
  config: { effort: "effort", model: "model" },
  // ponytail: his Claude app is the Mac's; a Windows link waits for a Windows install.
  continueOnMac: isOwn && !WINDOWS ? continueInClaudeApp : undefined,
  header: () => `Bearer \${${DOOR_KEY_ENV}}`,
  link: (ref) => `claude://claude.ai/epitaxy/local_${ref}`,
  listInApp: isOwn && !WINDOWS ? listInClaudeApp : undefined,
  // Every session of an agent, the fresh ones too, carries its title as its name in his app's list (`--name`).
  meta: (a) => ({
    claudeCode: {
      options: {
        extraArgs: { name: a.title },
        ...(isOwn
          ? { settings: { hooks: GUARD_HOOKS } }
          : {
              allowedTools: [
                "mcp__desk",
                ...(isSecondLifeReading() ? [`mcp__${READS_SERVER}`] : []),
              ],
              permissionMode: "default",
              settingSources: [],
              strictMcpConfig: true,
              tools: [],
            }),
      },
    },
  }),
  mode: isOwn ? "bypassPermissions" : undefined,
  onlyToolPrefixes: isOwn
    ? undefined
    : [
        "mcp__desk__",
        ...(isSecondLifeReading() ? [`mcp__${READS_SERVER}__`] : []),
      ],
  async readSessionState(ref) {
    // A process running it is his live session (or an orphaned run): never a second one beside it, between turns too.
    if (await isSessionOpen(ref)) {
      return "running";
    }
    return transcriptOf(ref) ? "idle" : "gone";
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
        [DOOR_KEY_ENV]: a.door.key,
        ...(isOwn
          ? {}
          : {
              CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
              CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
              // The reads' secrets, which its MCP servers inherit: never in `--mcp-config`, an argument.
              ...(isSecondLifeReading() ? connectorReadsOf().secrets : {}),
              ...(process.env.ANTHROPIC_BASE_URL
                ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL }
                : {}),
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

/** Whether `e` is a file or folder that is not there. */
const isMissing = (e: unknown) => (e as { code?: string }).code === "ENOENT";

const codexRow = (isOwn: boolean): Row => {
  const home = isOwn ? join(HOME, ".codex") : CODEX_HOME;
  /** The session's rollout, plain or compressed (Codex compresses idle ones), if Codex has one; a scan that fails otherwise throws (the session's state is then unknown, never gone). */
  const rolloutOf = (ref: string) => {
    try {
      return new Bun.Glob(`*/*/*/rollout-*-${ref}.jsonl{,.zst}`)
        .scanSync(join(home, "sessions"))
        .next().value;
    } catch (e) {
      if (!isMissing(e)) {
        throw e;
      }
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
  /** Whether the rollout holds his running turn: open and written to within `OPEN_FOR`. A file gone is not; one that can't be read (being rewritten) throws: its state is unknown, never idle. */
  const isOpenNow = (path: string) => {
    try {
      return (
        clock().getTime() - statSync(join(home, "sessions", path)).mtimeMs <
          OPEN_FOR && isRolloutTurnOpen(rolloutLines(path))
      );
    } catch (e) {
      if (isMissing(e)) {
        return false;
      }
      throw e;
    }
  };
  return {
    block: () => readCliBlock("codex"),
    config: { effort: "reasoning_effort", model: "model" },
    header: (key) => `Bearer ${key}`,
    link: (ref) => `codex://threads/${ref}`,
    onlyToolPrefixes: isOwn
      ? undefined
      : [
          "mcp.desk.",
          ...(isSecondLifeReading() ? [`mcp.${READS_SERVER}.`] : []),
        ],
    // biome-ignore lint/suspicious/useAwait: async, so a read that throws is a rejected state
    async readSessionState(ref) {
      const path = rolloutOf(ref);
      if (!path) {
        return "gone";
      }
      return isOpenNow(path) ? "running" : "idle";
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
): Record<Exclude<RuntimeName, "pi">, Row> => ({
  claude: claudeRow(isOwn),
  codex: codexRow(isOwn),
});
