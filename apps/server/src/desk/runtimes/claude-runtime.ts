import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, WINDOWS } from "../../core/platform";
import { exec, startDetached } from "../../core/proc";
import type { Agent, Run, Runtime, Usage } from "./contract";

// The `claude` runtime: Claude Code's CLI, one `claude -p` process per turn (the desk spec, 5.3; its runtime proofs,
// 18 Nov 2026). The session id is the desk's, chosen before the start, so the ref is known at once; a turn ends when
// its process does. The door reaches the session by `--mcp-config`, its key only through the environment. No model or
// permission flag: a session runs as he has Claude Code set up. Nothing is kept here: running is a process holding the
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
  "--mcp-config",
  JSON.stringify({
    mcpServers: {
      desk: {
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
  if (code > 1) {
    throw new Error(`pgrep: ${stderr}`);
  }
  return code === 0;
}

/**
 * Opens the new session in the Claude app, so its link works: once its transcript exists (the CLI refuses before),
 * under a pseudo-terminal (it refuses without one). It lists the session in the app; no process of the app runs it.
 */
async function handOff(a: Agent, ref: string) {
  for (let i = 0; i < 40 && !transcriptOf(ref); i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: waiting for one file
    await Bun.sleep(500);
  }
  await exec(
    ["script", "-q", "/dev/null", "claude", "--desktop", "--resume", ref],
    { cwd: a.folder, timeout: 30_000 }
  );
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
    const r = run(a, argsOf(a, brief, { start: ref }));
    if (!WINDOWS) {
      // ponytail: the Claude app's hand-off is the Mac's; a Windows link waits for a Windows install.
      handOff(a, ref).catch(() => undefined);
    }
    return Promise.resolve({
      ...r,
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
