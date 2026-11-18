import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../core/log";
import { HOME, isOwnLife, WINDOWS } from "../../core/platform";
import { exec, startDetached } from "../../core/proc";
import {
  type Agent,
  BEGIN_WITHIN_MS,
  begunWhen,
  cliBlockOf,
  isHeld,
  programOf,
  type Run,
  type Runtime,
  stopMatching,
  type Usage,
} from "./contract";

// The `claude` runtime: Claude Code's CLI, one `claude -p` process per turn (the desk spec, 5.3; its runtime proofs,
// 18 Nov 2026). The session id is the desk's, chosen before the start, so the ref is known at once; a turn ends when
// its process does. The door reaches the session by `--mcp-config`, its key only through the environment. Its model and
// effort when the agent has them (`--model`, `--effort`); no permission flag: a session runs as he has Claude Code set up. Nothing is kept here: running is a process holding the
// id while its transcript's last turn is open, idle a transcript on disk. A process alone is not a turn: the Claude app keeps an
// opened session's process warm, idle, up to 30 minutes (18 Nov 2026), and an answer must wake the agent at once.
// ponytail: that warm process keeps its own copy of the conversation; his message typed into it after a desk turn,
// before the app reloads it, branches the conversation (the desk's turn stays in the transcript).
// A second Life's agent (a demo, `isOwnLife` false) runs apart from his setup, since his connectors and files reach his
// own Life: its door alone (`SECOND_LIFE`), and never handed to his Claude app.

/**
 * A second Life's agent: none of his settings (hooks, plugins, permissions), no MCP server but the door, no built-in tool
 * (no shell, no file), the door's tools approved as the Codex runtime approves them; none of his CLAUDE.md or memory.
 */
const SECOND_LIFE = {
  args: [
    ...["--setting-sources", "", "--strict-mcp-config"],
    ...["--tools", "", "--allowedTools", "mcp__desk"],
  ],
  env: {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  },
};

const PROJECTS = join(HOME, ".claude", "projects");

/** The door as Claude's MCP config: the key is `${LIFE_DESK_KEY}`, which Claude reads from the environment (never argv). */
export const argsOf = (
  a: Agent,
  message: string,
  session: { resume: string } | { start: string },
  isOwn = isOwnLife()
) => [
  "claude",
  "-p",
  ...("start" in session
    ? ["--session-id", session.start, "-n", a.title]
    : ["--resume", session.resume]),
  ...(a.model ? ["--model", a.model] : []),
  ...(a.effort ? ["--effort", a.effort] : []),
  ...(isOwn ? [] : SECOND_LIFE.args),
  "--mcp-config",
  JSON.stringify({
    mcpServers: {
      desk: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude expands it from the environment
        headers: { Authorization: "Bearer ${LIFE_DESK_KEY}" },
        type: "http",
        url: a.door.url,
      },
    },
  }),
  "--",
  message,
];

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

/** A transcript's entries of the main conversation that can be read now: a line still being written is skipped. */
const readableEntries = (lines: string) =>
  lines.split("\n").flatMap((l) => {
    try {
      const e = JSON.parse(l) as Entry;
      return e.isSidechain ? [] : [e];
    } catch {
      return [];
    }
  });

/** How many prompts a transcript holds (none: Claude wrote none yet). */
const promptsIn = (lines: string | undefined) =>
  lines ? readableEntries(lines).filter(isPrompt).length : 0;

/**
 * Whether the model has answered a run's prompt: an assistant entry after the prompt that follows the `before` prompts the
 * transcript held when the run was launched (none: Claude wrote none yet).
 */
export function hasAnswered(lines: string | undefined, before: number) {
  let prompts = 0;
  for (const e of lines ? readableEntries(lines) : []) {
    if (isPrompt(e)) {
      prompts += 1;
    } else if (prompts > before && e.type === "assistant") {
      return true;
    }
  }
  return false;
}

/** Runs one turn in `a.folder`: its process's exit is the turn's end; it began once the model answered its prompt. */
function run(a: Agent, argv: string[], ref: string): Run {
  const before = promptsIn(readTranscript(ref));
  const [program = "", ...args] = argv;
  const ended = startDetached([programOf(program), ...args], {
    cwd: a.folder,
    env: {
      LIFE_DESK_KEY: a.door.key,
      ...(isOwnLife() ? {} : SECOND_LIFE.env),
    },
  }).then((code) => ({ ok: code === 0 }));
  const begun = begunWhen(
    ended,
    () => hasAnswered(readTranscript(ref), before),
    () => transcriptOf(ref)
  );
  return { begun, ended };
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
      programOf("claude"),
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

interface Entry {
  isSidechain?: boolean;
  message?: {
    content?: unknown;
    id?: string;
    stop_reason?: string | null;
    usage?: {
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  type?: string;
}

/** A prompt (not a tool's result): where a turn starts. */
const isPrompt = (e: Entry) =>
  e.type === "user" &&
  (typeof e.message?.content === "string" ||
    (Array.isArray(e.message?.content) &&
      e.message.content.some((c: { type?: string }) => c.type === "text")));

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
 * A transcript's usage: its growth (the last call's context less the first's) and its last turn's tokens, summed over
 * its calls (a call is written once per content block, under one message id).
 */
export function usageOf(lines: string): Usage | null {
  const entries = entriesOf(lines);
  const turnStart = entries.findLastIndex(isPrompt);
  const calls = new Map<string, { last: boolean; u: Usage }>();
  for (const [i, e] of entries.entries()) {
    const u = e.message?.usage;
    if (e.type === "assistant" && u && e.message?.id) {
      const cached = u.cache_read_input_tokens ?? 0;
      const fresh =
        (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      calls.set(e.message.id, {
        last: i > turnStart,
        u: {
          grownBy: fresh + cached,
          tokensCached: cached,
          tokensIn: fresh,
          tokensOut: u.output_tokens ?? 0,
        },
      });
    }
  }
  const all = [...calls.values()];
  const [first] = all;
  const latest = all.at(-1);
  if (!(first && latest)) {
    return null;
  }
  const turn = all.filter((c) => c.last).map((c) => c.u);
  const sum = (k: keyof Usage) => turn.reduce((n, u) => n + u[k], 0);
  return {
    grownBy: latest.u.grownBy - first.u.grownBy,
    tokensCached: sum("tokensCached"),
    tokensIn: sum("tokensIn"),
    tokensOut: sum("tokensOut"),
  };
}

export const claudeRuntime: Runtime = {
  beginWithinMs: BEGIN_WITHIN_MS,
  block: () => cliBlockOf("claude"),
  hasBegun(ref) {
    const lines = readTranscript(ref);
    return Promise.resolve(hasAnswered(lines, promptsIn(lines) - 1));
  },
  async send(a, ref, message) {
    // A turn running beside his would branch the conversation.
    if ((await claudeRuntime.state(ref)) === "running") {
      throw new Error(`session ${ref} is running`);
    }
    return run(a, argsOf(a, message, { resume: ref }), ref);
  },
  start(a, brief) {
    const ref = randomUUID();
    const { begun, ended } = run(a, argsOf(a, brief, { start: ref }), ref);
    return Promise.resolve({
      begun,
      // The first turn's end waits for the hand-off, so no next turn runs beside it.
      // ponytail: the Claude app's hand-off is the Mac's; a Windows link waits for a Windows install.
      ended: ended.then(async (end) => {
        if (!WINDOWS && isOwnLife()) {
          await handOff(a, ref);
        }
        return end;
      }),
      link: `claude://claude.ai/epitaxy/local_${ref}`,
      ref,
    });
  },
  async state(ref) {
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
  async stop(ref) {
    // The desk's own `claude -p` runs only, never the Claude app's warm process.
    await stopMatching(` -p .*${ref}`);
  },
  usage(ref) {
    const lines = readTranscript(ref);
    return Promise.resolve(lines === undefined ? null : usageOf(lines));
  },
};
