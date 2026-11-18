// The runtime contract: what the desk needs from the program a registered agent's sessions run in (`claude`, `codex`,
// `dsh`; one file each). Each turn is one run the runtime starts; its end is that run's end (`ended`), which the desk's
// clock takes as the turn's end (`turnEnded`, `desk-clock.ts`).

/** A turn under way: settled when it ends, `ok` false when it failed. */
export interface Run {
  ended: Promise<{ ok: boolean }>;
}

/** What a session's transcript says: its growth since its first turn (the fresh-session rule), and its last turn's tokens. */
export interface Usage {
  grownBy: number;
  tokensCached: number;
  tokensIn: number;
  tokensOut: number;
}

/** What the desk gives a session it starts: the agent, where it runs, and its door (its MCP address; the key is the runtime's env). */
export interface Agent {
  door: { key: string; url: string };
  folder: string;
  id: string;
  title: string;
}

export interface Runtime {
  /** Runs `message` in the session now, answering once the turn is under way; refused while anything else runs it. */
  send: (agent: Agent, ref: string, message: string) => Promise<Run>;
  /** Starts a session in `agent.folder` with `brief` as its first message, answering once it is under way: its ref, and a link that opens it. */
  start: (
    agent: Agent,
    brief: string
  ) => Promise<Run & { link: string; ref: string }>;
  /** Whether the session runs a turn now (the desk's or his), is idle, or is no longer known (deleted, archived). */
  state: (ref: string) => Promise<"running" | "idle" | "gone">;
  /** The session's usage, or null when it can't say (a wake then sends into it). */
  usage: (ref: string) => Promise<Usage | null>;
}
