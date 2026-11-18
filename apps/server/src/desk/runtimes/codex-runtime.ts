import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { clock } from "../../core/clock";
import { DESK_RUNS } from "../../core/paths";
import { cliEnv, HOME } from "../../core/platform";
import { exec, firstLine, startDetached } from "../../core/proc";
import {
  type Agent,
  blockOf,
  type Run,
  type Runtime,
  type Usage,
} from "./contract";

// The `codex` runtime: Codex's CLI, one `codex exec resume` process per turn (the desk spec, 5.3; its runtime proofs,
// 18 Nov 2026). The session is made first through `codex app-server` (`thread/start`): unlike a thread `exec` makes, it
// is listed in the Codex app. Its turn's events go to a file of their own, `begun` is `turn.started` in it and the
// turn's end is the process's exit. His real `~/.codex`, never Life's own Codex home (model calls, no tools). The door
// reaches the session by `-c`, its key only through the environment; its tools are approved for the desk server alone
// (`exec` auto-denies an MCP tool otherwise). Nothing is kept here: running is a process holding the id, idle a
// rollout on disk.
// ponytail: a turn of his in the Codex app holds no process with the id, so it looks idle; the desk may send beside it.

const SESSIONS = join(HOME, ".codex", "sessions");
const BEGUN_POLL_MS = 250;

/** A TOML string for `-c key=value`. */
const toml = (s: string) => JSON.stringify(s);

/** The command that runs one turn of session `ref`: its key is never in it. */
export const codexArgsOf = (a: Agent, ref: string, message: string) => [
  "codex",
  "exec",
  "resume",
  ref,
  "--json",
  "--skip-git-repo-check",
  ...(a.model ? ["-m", a.model] : []),
  ...(a.effort ? ["-c", `model_reasoning_effort=${toml(a.effort)}`] : []),
  "-c",
  `mcp_servers.desk.url=${toml(a.door.url)}`,
  "-c",
  `mcp_servers.desk.bearer_token_env_var=${toml("LIFE_DESK_KEY")}`,
  "-c",
  `mcp_servers.desk.default_tools_approval_mode=${toml("approve")}`,
  "--",
  message,
];

/** Whether a run's events hold `type`'s line. */
export const hasEvent = (events: string, type: string) =>
  events
    .split("\n")
    .some((l) => l.startsWith('{"type":') && l.includes(`"${type}"`));

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/** Settles when the run's events show `turn.started`; rejects when the process ended without it. */
async function begunIn(path: string, ended: Promise<unknown>) {
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
    const isOverNow = isOver;
    if (hasEvent(read(path), "turn.started")) {
      return;
    }
    if (isOverNow) {
      throw new Error("its process ended before the turn began");
    }
    // biome-ignore lint/performance/noAwaitInLoops: polls the run's events
    await Bun.sleep(BEGUN_POLL_MS);
  }
}

/** Runs one turn in `a.folder`: its process's exit is the turn's end, ok with a `turn.completed` in its events. */
function run(a: Agent, ref: string, message: string): Run {
  mkdirSync(DESK_RUNS, { recursive: true });
  const path = join(DESK_RUNS, `${ref}-${clock().getTime()}.jsonl`);
  const ended = startDetached(codexArgsOf(a, ref, message), {
    cwd: a.folder,
    env: { LIFE_DESK_KEY: a.door.key },
    stdout: path,
  }).then((code) => {
    const isOk = code === 0 && hasEvent(read(path), "turn.completed");
    // A failed run's events stay for whoever looks.
    if (isOk) {
      rmSync(path, { force: true });
    }
    return { ok: isOk };
  });
  return { begun: begunIn(path, ended), ended };
}

/** A new thread in `folder`, through a short-lived `codex app-server` (killed once it answers): its id. */
async function newThread(folder: string) {
  const line = await firstLine(
    ["codex", "app-server"],
    [
      {
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "life-desk", version: "1" } },
      },
      { method: "initialized" },
      { id: 2, method: "thread/start", params: { cwd: folder } },
    ]
      .map((m) => `${JSON.stringify(m)}\n`)
      .join(""),
    (l) => JSON.parse(l).id === 2,
    { env: cliEnv(), timeout: 30_000 }
  );
  const answer = line ? JSON.parse(line) : undefined;
  const id: unknown = answer?.result?.thread?.id;
  if (typeof id !== "string") {
    throw new Error(
      `codex app-server gave no thread: ${JSON.stringify(answer?.error ?? "no answer").slice(0, 200)}`
    );
  }
  return id;
}

/** The session's rollout, if Codex wrote one (an archived thread has none here). */
const rolloutOf = (ref: string) => {
  try {
    return new Bun.Glob(`*/*/*/rollout-*-${ref}.jsonl`)
      .scanSync(SESSIONS)
      .next().value;
  } catch {
    // no sessions folder yet
  }
};

interface Rollout {
  payload?: {
    info?: {
      last_token_usage?: {
        cached_input_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
      };
      total_token_usage?: { total_tokens?: number };
    } | null;
    type?: string;
  };
  type?: string;
}

/**
 * A rollout's usage: its growth (the last call's context less the first's; `input_tokens` already counts the cached
 * ones) and its last turn's tokens, summed over its calls. A `token_count` repeating the previous total is the same call.
 */
export function rolloutUsageOf(lines: string): Usage | null {
  const calls: {
    cached: number;
    context: number;
    out: number;
    turn: number;
  }[] = [];
  let turn = 0;
  let total: number | undefined;
  for (const l of lines.split("\n").filter(Boolean)) {
    const { payload: p, type } = JSON.parse(l) as Rollout;
    if (type !== "event_msg") {
      continue;
    }
    if (p?.type === "task_started") {
      turn += 1;
    }
    const u = p?.info?.last_token_usage;
    const t = p?.info?.total_token_usage?.total_tokens;
    if (p?.type === "token_count" && u && t !== total) {
      total = t;
      calls.push({
        cached: u.cached_input_tokens ?? 0,
        context: u.input_tokens ?? 0,
        out: u.output_tokens ?? 0,
        turn,
      });
    }
  }
  const [first] = calls;
  const latest = calls.at(-1);
  if (!(first && latest)) {
    return null;
  }
  const last = calls.filter((c) => c.turn === latest.turn);
  const sum = (f: (c: (typeof calls)[number]) => number) =>
    last.reduce((n, c) => n + f(c), 0);
  return {
    grownBy: latest.context - first.context,
    tokensCached: sum((c) => c.cached),
    tokensIn: sum((c) => c.context - c.cached),
    tokensOut: sum((c) => c.out),
  };
}

export const codexRuntime: Runtime = {
  block: () => blockOf("codex"),
  async send(a, ref, message) {
    if ((await codexRuntime.state(ref)) === "running") {
      throw new Error(`session ${ref} is running`);
    }
    return run(a, ref, message);
  },
  async start(a, brief) {
    const ref = await newThread(a.folder);
    return {
      ...(await codexRuntime.send(a, ref, brief)),
      link: `codex://threads/${ref}`,
      ref,
    };
  },
  async state(ref) {
    // 1: no process; anything else (-1: pgrep could not start) is no answer, never "free".
    const { code, stderr } = await exec(["pgrep", "-f", ref]);
    if (code !== 0 && code !== 1) {
      throw new Error(`pgrep: ${stderr}`);
    }
    if (code === 0) {
      return "running";
    }
    return rolloutOf(ref) ? "idle" : "gone";
  },
  usage(ref) {
    const path = rolloutOf(ref);
    return Promise.resolve(
      path ? rolloutUsageOf(readFileSync(join(SESSIONS, path), "utf8")) : null
    );
  },
};
