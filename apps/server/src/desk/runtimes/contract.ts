// The runtime contract: what the desk needs from the program a registered agent's sessions run in (`claude`, `codex`:
// one row each, `runtime-rows.ts`, driven by `acp-runtime.ts`). Each turn is one run the runtime starts: one adapter
// process speaking ACP, whose prompt reply is the run's end (`ended`), which the desk's clock takes as the turn's end
// (`turnEnded`, `desk-clock.ts`).

/** How a run ended: `ok` false when it failed (`why`: its stop reason or error), and what it used (none when it failed or the runtime can't say). */
export interface RunEnd {
  ok: boolean;
  usage?: Usage;
  why?: string;
}

/** A turn launched: `begun` settles when its model has answered (rejects with why when it ended first), `ended` when it ends. */
export interface Run {
  begun: Promise<void>;
  ended: Promise<RunEnd>;
}

/** The turn's tokens, and the whole context of its first and last call (null when the runtime reported none): the session's growth is `growthOf`'s. */
export interface Usage {
  contextFirst: number | null;
  contextLast: number | null;
  tokensCached: number;
  tokensIn: number;
  tokensOut: number;
}

/** What the desk gives a session it starts or wakes: the agent, where it runs, its model, and its door (its MCP address and key). */
export interface Agent {
  door: { key: string; url: string };
  /** Its effort and model (`modelOf`): null leaves the runtime's own default. */
  effort: string | null;
  folder: string;
  id: string;
  model: string | null;
  title: string;
}

export interface Runtime {
  /** Why the program can't run now (not installed, not answering); none when it can: the same meaning as `SendPath.block`. */
  block: () => Promise<string | undefined>;
  /** Launches `message` in the session now, answering once the run is launched (`Run.begun` says when the turn is under way); refused while anything else runs it. */
  send: (agent: Agent, ref: string, message: string) => Promise<Run>;
  /** Starts a session in `agent.folder` with `brief` as its first message, answering once its run is launched: its ref, and a link that opens it. */
  start: (
    agent: Agent,
    brief: string
  ) => Promise<Run & { link: string; ref: string }>;
  /** Whether the session runs a turn now (the desk's or his), is idle, or is no longer known (deleted, archived). */
  state: (ref: string) => Promise<"running" | "idle" | "gone">;
  /** Stops the desk's own run of the session, if one runs (never his app's process). */
  stop: (ref: string) => Promise<void>;
}
