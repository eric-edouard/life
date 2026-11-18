// The runtime contract: what the desk needs from the program a registered agent's sessions run in (`claude`, `codex`,
// `dsh`; one file each, step 3 on). The runtime reports a turn's end to the desk (`turnEnded`, `desk-clock.ts`).

export interface Runtime {
  /** Context tokens the session holds now; null when it can't say (a wake then sends into it). */
  contextTokens: (ref: string) => Promise<number | null>;
  /**
   * Runs `message` in the session now, answering once the turn is under way, never at its end (the desk starts turns
   * one after another); may answer with a new ref (a copy of a session already running).
   */
  send: (ref: string, message: string) => Promise<{ ref: string }>;
  /** Starts a session in `folder` with `brief` as its first message, answering once it is under way: its ref, and a link that opens it. */
  start: (
    agent: { folder: string; id: string; title: string },
    brief: string
  ) => Promise<{ link: string; ref: string }>;
  /** Whether the session runs a turn now, is idle, or is no longer known (deleted, archived). */
  state: (ref: string) => Promise<"running" | "idle" | "gone">;
}
