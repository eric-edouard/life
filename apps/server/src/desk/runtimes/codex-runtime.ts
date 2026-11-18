import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { clock, MIN } from "../../core/clock";
import { linesOf } from "../../core/files";
import { log } from "../../core/log";
import { DESK_RUNS } from "../../core/paths";
import { cliEnv, HOME, isOwnLife } from "../../core/platform";
import { firstLine, startDetached } from "../../core/proc";
import { CODEX_AGENT_OFF, CODEX_HOME, CODEX_OFF, toml } from "../../models/llm";
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

// The `codex` runtime: Codex's CLI, one `codex exec resume` process per turn (the desk spec, 5.3; its runtime proofs,
// 18 Nov 2026). The session is made first through `codex app-server` (`thread/start`): unlike a thread `exec` makes, it
// is listed in the Codex app. Its turn's events go to a file of their own, `begun` is the model's first item in it and the
// turn's end is the process's exit. His real `~/.codex`, never Life's own Codex home (model calls, no tools). The door
// reaches the session by `-c`, its key only through the environment; its tools are approved for the desk server alone
// (`exec` auto-denies an MCP tool otherwise). Nothing is kept here: running is a process holding the id, idle a
// rollout on disk.
// A second Life's agent (a demo, `isOwnLife` false) runs apart from his setup, since his MCP servers and files reach his
// own Life: its door alone (`SECOND_LIFE`), as the claude runtime's, and never in his Codex app.
// ponytail: his own turn in the Codex app holds no process with the id; it counts as running while the rollout's last
// turn is open and was written in the last 10 minutes (`isOpenNow`), so a tool call silent for longer reads idle and the
// desk may send beside it. And the app holding the thread open while idle keeps its own copy: his next message there may
// continue from it, missing the desk's turn (as the claude runtime's warm process does).

/**
 * A second Life's agent: Life's own Codex home (a login of its own, as Life's model engine; none of his AGENTS.md,
 * config, MCP servers or sessions), none of his rules, no instruction file of its folder, no skill, web search or extra,
 * no shell and a read-only sandbox (its door's tools reached as the question cases' agent reaches Life's).
 */
const SECOND_LIFE = {
  args: [
    ...["--ignore-user-config", "--ignore-rules"],
    ...[...CODEX_OFF, ...CODEX_AGENT_OFF].flatMap((f) => ["--disable", f]),
    ...[
      'sandbox_mode="read-only"',
      "project_doc_max_bytes=0",
      'web_search="disabled"',
      "skills.bundled.enabled=false",
      "skills.include_instructions=false",
    ].flatMap((c) => ["-c", c]),
  ],
  env: { CODEX_HOME },
};

/** The Codex home its sessions run in: his own `~/.codex`, or a second Life's Life's own. */
export const codexHomeOf = () =>
  isOwnLife() ? join(HOME, ".codex") : CODEX_HOME;

/** Where its sessions' rollouts are. */
const sessionsDir = () => join(codexHomeOf(), "sessions");

/** What a codex process is given besides `cliEnv`. */
const envOf = (): Record<string, string> =>
  isOwnLife() ? {} : SECOND_LIFE.env;

/** The command that runs one turn of session `ref`: its key is never in it. */
export const codexArgsOf = (
  a: Agent,
  ref: string,
  message: string,
  isOwn = isOwnLife()
) => [
  "codex",
  "exec",
  "resume",
  ref,
  "--json",
  "--skip-git-repo-check",
  ...(isOwn ? [] : SECOND_LIFE.args),
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

/** The events in complete JSON lines: a line that is not one is skipped. */
const eventsOf = (lines: string[]) =>
  lines.flatMap((l) => {
    try {
      return [JSON.parse(l) as Event];
    } catch {
      return [];
    }
  });

interface Event {
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

/** Whether a run's events (its `--json` lines) hold `type`. */
export const hasEvent = (lines: string[], type: string) =>
  eventsOf(lines).some((e) => e.type === type);

/** Whether the model has answered in a run's events: its first item (a message, a tool call), not `turn.started`, which comes before any model call. */
export const hasAnswered = (lines: string[]) =>
  eventsOf(lines).some((e) => e.type?.startsWith("item."));

/** The files of session `ref`'s runs, oldest first (one name each: `<ref>-<ms>.jsonl`). */
const runFilesOf = (ref: string) => {
  try {
    return [...new Bun.Glob(`${ref}-*.jsonl`).scanSync(DESK_RUNS)]
      .toSorted()
      .map((f) => join(DESK_RUNS, f));
  } catch {
    return []; // no runs folder yet
  }
};

/**
 * Runs one turn in `a.folder`: its process's exit is the turn's end, ok with a `turn.completed` in its events. `begun`
 * watches the events file and is settled before the file goes, so a turn that began and ended at once still began.
 */
function run(a: Agent, ref: string, message: string): Run {
  mkdirSync(DESK_RUNS, { recursive: true });
  const path = join(DESK_RUNS, `${ref}-${clock().getTime()}.jsonl`);
  // Made before the process, so `begunWhen` can watch it from the start.
  writeFileSync(path, "");
  const [program = "", ...args] = codexArgsOf(a, ref, message);
  const exited = startDetached([programOf(program), ...args], {
    cwd: a.folder,
    env: { ...envOf(), LIFE_DESK_KEY: a.door.key },
    stdout: path,
  });
  const begun = begunWhen(
    exited,
    () => hasAnswered(linesOf(path)),
    () => path
  );
  const ended = (async () => {
    const code = await exited;
    await begun.catch(() => undefined);
    const lines = linesOf(path);
    const isOk = code === 0 && hasEvent(lines, "turn.completed");
    // Its events hold what the agent read: never kept; a failure logs the last of them.
    if (!isOk) {
      log("desk.runtime", {
        agent: a.id,
        error: lines.join("\n").slice(-300),
        ok: false,
        what: "turn",
      });
    }
    rmSync(path, { force: true });
    return { ok: isOk };
  })();
  return { begun, ended };
}

/** A new thread in `folder`, through a short-lived `codex app-server` (killed once it answers): its id. */
async function newThread(folder: string) {
  const line = await firstLine(
    [programOf("codex"), "app-server"],
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
    { env: { ...cliEnv(), ...envOf() }, timeout: 30_000 }
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

/** The session's rollout, plain or compressed (Codex compresses idle ones; `exec resume` takes both), if Codex has one. */
const rolloutOf = (ref: string) => {
  try {
    return new Bun.Glob(`*/*/*/rollout-*-${ref}.jsonl{,.zst}`)
      .scanSync(sessionsDir())
      .next().value;
  } catch {
    // no sessions folder yet
  }
};

/** A rollout's complete lines. */
function rolloutLines(path: string) {
  const file = join(sessionsDir(), path);
  if (!path.endsWith(".zst")) {
    return linesOf(file);
  }
  const lines = new TextDecoder()
    .decode(Bun.zstdDecompressSync(readFileSync(file)))
    .split("\n");
  lines.pop();
  return lines;
}

/** How long a rollout's open turn counts as his running turn, written to or not. */
const OPEN_FOR = 10 * MIN;

/** Whether a rollout's last turn is open: `task_started` is the last of its turn events (a killed turn leaves one open). */
export const isRolloutTurnOpen = (lines: string[]) =>
  eventsOf(lines).findLast((e) =>
    ["task_started", "task_complete", "turn_aborted"].includes(
      e.payload?.type ?? ""
    )
  )?.payload?.type === "task_started";

/** Whether the rollout holds his running turn: open and written to within `OPEN_FOR`. A file gone or being rewritten is not. */
function isOpenNow(path: string) {
  try {
    return (
      clock().getTime() - statSync(join(sessionsDir(), path)).mtimeMs <
        OPEN_FOR && isRolloutTurnOpen(rolloutLines(path))
    );
  } catch {
    return false;
  }
}

/**
 * A rollout's usage: its growth (the last call's context less the first's; `input_tokens` already counts the cached
 * ones) and its last turn's tokens, summed over its calls. A `token_count` repeating the previous total is the same call.
 */
export function rolloutUsageOf(lines: string[]): Usage | null {
  const calls: {
    cached: number;
    context: number;
    out: number;
    turn: number;
  }[] = [];
  let turn = 0;
  let total: number | undefined;
  for (const { payload: p, type } of eventsOf(lines)) {
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
  beginWithinMs: BEGIN_WITHIN_MS,
  block: () => cliBlockOf("codex"),
  hasBegun(ref) {
    const last = runFilesOf(ref).at(-1);
    return Promise.resolve(last ? hasAnswered(linesOf(last)) : false);
  },
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
    if (await isHeld(ref)) {
      return "running";
    }
    const path = rolloutOf(ref);
    if (!path) {
      return "gone";
    }
    return isOpenNow(path) ? "running" : "idle";
  },
  async stop(ref) {
    // The desk's own runs only: his Codex app holds no process with the id.
    await stopMatching(`exec resume ${ref}`);
    for (const f of runFilesOf(ref)) {
      rmSync(f, { force: true });
    }
  },
  usage(ref) {
    const path = rolloutOf(ref);
    try {
      return Promise.resolve(path ? rolloutUsageOf(rolloutLines(path)) : null);
    } catch {
      return Promise.resolve(null); // a file Codex is compressing or rewriting: the wake sends into it
    }
  },
};
