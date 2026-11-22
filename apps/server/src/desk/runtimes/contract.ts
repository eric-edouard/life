// The runtime contract: what the desk needs from the program a registered agent's sessions run in (`claude`, `codex`:
// one row each, `runtime-rows.ts`, driven by `acp-runtime.ts`). Each turn is one run the runtime starts: one adapter
// process speaking ACP, whose prompt reply is the run's end (`ended`), which the desk's clock takes as the turn's end
// (`turnEnded`, `desk-clock.ts`). The main session's runs (`talk`) share one process kept open across them.

/** The variable a runtime's process gets its door's key in (Claude expands it in the door's header; pi's extension reads it). */
export const DOOR_KEY_ENV = "LIFE_DESK_KEY";

/** `send`'s refusal of a session live elsewhere (his app, a terminal): the wake waits for it, never a failed turn. */
export class SessionLive extends Error {}

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

/** One model call's usage, as pi's assistant messages carry it. */
export interface CallUsage {
  cacheRead: number;
  cacheWrite: number;
  cost?: { total: number; totalFromProvider?: boolean };
  input: number;
  output: number;
  totalTokens: number;
}

/** The turn's tokens, and the whole context of its first and last call (null when the runtime reported none), kept as a record: no decision reads it. */
export interface Usage {
  /** Dollars the provider billed for the run (pi on OpenRouter): none on a plan's runtime; null when a call came without its cost. */
  billedUsd?: number | null;
  contextFirst: number | null;
  contextLast: number | null;
  /** Dollars its web searches cost (`web_search`, pi only): none on a runtime without it; null when a search came without its price. */
  searchUsd?: number | null;
  tokensCached: number;
  tokensIn: number;
  tokensOut: number;
}

/** What a run's model says and does as it goes (`Runtime.talk`): a chunk of its words, that it thinks, a tool call and its state. */
export type Update =
  | { kind: "thinking" }
  | { kind: "words"; text: string }
  | { id: string; kind: "working"; state: string; title: string };

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
  /**
   * Opens session `ref` on his Mac for him to continue there (his word, `continue_on_mac`), answering once the Mac says it
   * opened; while open there, `state` says `running` and the desk holds its wakes. None: this runtime can't yet.
   */
  continueOnMac?: (agent: Agent, ref: string) => Promise<void>;
  /** Keeps session `ref` open for `agent` with no prompt (his presence on Ask Life), as `talk` keeps it; refused with `SessionLive` while anything else runs it. */
  keep: (agent: Agent, ref: string) => Promise<void>;
  /** Launches `message` in the session now, answering once the run is launched (`Run.begun` says when the turn is under way); refused with `SessionLive` while anything else runs it. */
  send: (agent: Agent, ref: string, message: string) => Promise<Run>;
  /** Starts a session in `agent.folder` with `brief` as its first message, answering once its run is launched: its ref, and a link that opens it. */
  start: (
    agent: Agent,
    brief: string
  ) => Promise<Run & { link: string; ref: string }>;
  /** Whether the session is live now (the desk's turn, or his app or CLI running it, between his turns too), idle, or no longer known (deleted, archived). */
  state: (ref: string) => Promise<"running" | "idle" | "gone">;
  /** Stops the desk's own run of the session, if one runs (never his app's process), and closes it if kept. */
  stop: (ref: string) => Promise<void>;
  /**
   * Launches `message` on session `ref` (null: the one kept, else a new one) kept open across prompts, never handed to his app: the main
   * session's (Ask Life). `onUpdate` hears the run as it goes. Refused with `SessionLive` while anything else runs it, or
   * while its last prompt runs.
   */
  talk: (
    agent: Agent,
    ref: string | null,
    message: string,
    onUpdate: (u: Update) => void
  ) => Promise<Run & { link: string; ref: string }>;
}
