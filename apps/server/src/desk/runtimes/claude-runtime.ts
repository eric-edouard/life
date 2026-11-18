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
// id, idle a transcript on disk.

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

/** Runs one turn in `a.folder`: its process's exit is the turn's end. */
const run = (a: Agent, argv: string[]): Run => ({
  ended: startDetached(argv, {
    cwd: a.folder,
    env: { LIFE_DESK_KEY: a.door.key },
  }).then((code) => ({ ok: code === 0 })),
});

/** The session's transcript, if Claude wrote one. */
const transcriptOf = (ref: string) =>
  new Bun.Glob(`*/${ref}.jsonl`).scanSync(PROJECTS).next().value;

/** Whether some process runs session `ref` now: the desk's turn, or his in the app. */
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
 * under a pseudo-terminal (it refuses without one). It lists the session in the app; no process of the app runs it.
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

/**
 * A transcript's usage: its growth (the last call's context less the first's) and its last turn's tokens, summed over
 * its calls (a call is written once per content block, under one message id).
 */
export function usageOf(lines: string): Usage | null {
  const entries = lines
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Entry)
    .filter((e) => !e.isSidechain);
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
  async send(a, ref, message) {
    // His turn in the app holds the session: a run beside it would branch the conversation.
    if (await isHeld(ref)) {
      throw new Error(`session ${ref} is running`);
    }
    return run(a, argsOf(a, message, { resume: ref }));
  },
  start(a, brief) {
    const ref = randomUUID();
    const { ended } = run(a, argsOf(a, brief, { start: ref }));
    return Promise.resolve({
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
    if (await isHeld(ref)) {
      return "running";
    }
    return transcriptOf(ref) ? "idle" : "gone";
  },
  usage(ref) {
    const path = transcriptOf(ref);
    return Promise.resolve(
      path ? usageOf(readFileSync(join(PROJECTS, path), "utf8")) : null
    );
  },
};
