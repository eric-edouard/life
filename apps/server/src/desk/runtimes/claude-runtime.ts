import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../core/log";
import { HOME, WINDOWS } from "../../core/platform";
import { exec, startDetached } from "../../core/proc";
import type { Agent, Run, Runtime, Usage } from "./contract";

// The `claude` runtime: Claude Code's CLI, one `claude -p` process per turn (the desk spec, 5.3; its runtime proofs,
// 18 Nov 2026). The session id is the desk's, chosen before the start, so the ref is known at once; a turn ends when
// its process does. The door reaches the session by `--mcp-config`, its key only through the environment. Its model and
// effort when the agent has them (`--model`, `--effort`); no permission flag: a session runs as he has Claude Code set up. Nothing is kept here: running is a process holding the
// id while its transcript's last turn is open, idle a transcript on disk. A process alone is not a turn: the Claude app keeps an
// opened session's process warm, idle, up to 30 minutes (18 Nov 2026), and an answer must wake the agent at once.
// ponytail: that warm process keeps its own copy of the conversation; his message typed into it after a desk turn,
// before the app reloads it, branches the conversation (the desk's turn stays in the transcript).

const PROJECTS = join(HOME, ".claude", "projects");

/** The door as Claude's MCP config: the key is `${LIFE_DESK_KEY}`, which Claude reads from the environment (never argv). */
export const argsOf = (
  a: Agent,
  message: string,
  session: { resume: string } | { start: string }
) => [
  "claude",
  "-p",
  ...("start" in session
    ? ["--session-id", session.start, "-n", a.title]
    : ["--resume", session.resume]),
  ...(a.model ? ["--model", a.model] : []),
  ...(a.effort ? ["--effort", a.effort] : []),
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

/** The session's transcript, if Claude wrote one. */
const transcriptOf = (ref: string) =>
  new Bun.Glob(`*/${ref}.jsonl`).scanSync(PROJECTS).next().value;

const BEGUN_POLL_MS = 250;

/**
 * Settles when the turn's prompt is in the transcript (its last turn open); rejects when the run ended first, except a
 * first turn (`isFirst`) whose transcript exists: it began and was done before this looked.
 */
async function begunIn(ref: string, isFirst: boolean, ended: Promise<unknown>) {
  let isOver = false;
  ended.then(
    () => {
      isOver = true;
    },
    () => {
      isOver = true;
    }
  );
  for (;;) {
    const path = transcriptOf(ref);
    if (
      path &&
      (isFirst && isOver
        ? true
        : isTurnOpen(readFileSync(join(PROJECTS, path), "utf8")))
    ) {
      return;
    }
    if (isOver) {
      throw new Error("its process ended before the turn began");
    }
    // biome-ignore lint/performance/noAwaitInLoops: polls the transcript
    await Bun.sleep(BEGUN_POLL_MS);
  }
}

/** Runs one turn in `a.folder`: its process's exit is the turn's end. */
function run(a: Agent, argv: string[], ref: string, isFirst = false): Run {
  const ended = startDetached(argv, {
    cwd: a.folder,
    env: { LIFE_DESK_KEY: a.door.key },
  }).then((code) => ({ ok: code === 0 }));
  return { begun: begunIn(ref, isFirst, ended), ended };
}

/** Whether some process holds session `ref`: the desk's turn, his in the app, or the app's idle warm process. */
async function isHeld(ref: string) {
  const { code, stderr } = await exec(["pgrep", "-f", ref]);
  // 1: no process; anything else (-1: pgrep could not start) is no answer, never "free".
  if (code !== 0 && code !== 1) {
    throw new Error(`pgrep: ${stderr}`);
  }
  return code === 0;
}

/**
 * Opens session `ref` in the Claude app, so its link works: once no process runs it (the CLI refuses while one does),
 * under a pseudo-terminal (it refuses without one). It lists the session in the app, which keeps a process warm for it.
 */
async function handOff(a: Agent, ref: string) {
  const r = await exec(
    ["script", "-q", "/dev/null", "claude", "--desktop", "--resume", ref],
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
  async block() {
    const r = await exec(["claude", "--version"], { timeout: 5000 });
    return r.code === 0
      ? undefined
      : `claude --version failed: ${r.stderr.slice(-200) || r.code}`;
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
    const { begun, ended } = run(
      a,
      argsOf(a, brief, { start: ref }),
      ref,
      true
    );
    return Promise.resolve({
      begun,
      // The first turn's end waits for the hand-off, so no next turn runs beside it.
      // ponytail: the Claude app's hand-off is the Mac's; a Windows link waits for a Windows install.
      ended: ended.then(async (end) => {
        if (!WINDOWS) {
          await handOff(a, ref);
        }
        return end;
      }),
      link: `claude://claude.ai/epitaxy/local_${ref}`,
      ref,
    });
  },
  async state(ref) {
    const path = transcriptOf(ref);
    if (
      (await isHeld(ref)) &&
      // No transcript yet: the process alone says.
      (!path || isTurnOpen(readFileSync(join(PROJECTS, path), "utf8")))
    ) {
      return "running";
    }
    return path ? "idle" : "gone";
  },
  usage(ref) {
    const path = transcriptOf(ref);
    return Promise.resolve(
      path ? usageOf(readFileSync(join(PROJECTS, path), "utf8")) : null
    );
  },
};
