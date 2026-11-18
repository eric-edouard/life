// The runtime contract: what the desk needs from the program a registered agent's sessions run in (`claude`, `codex`;
// one file each). Each turn is one run the runtime starts; its end is that run's end (`ended`), which the desk's
// clock takes as the turn's end (`turnEnded`, `desk-clock.ts`).

import { type FSWatcher, watch } from "node:fs";
import { MIN } from "../../core/clock";
import { cliEnv } from "../../core/platform";
import { exec } from "../../core/proc";

/** A turn the runtime launched: `begun` settles when its model has answered (rejects with why when it ended first), `ended` when it ends, `ok` false when it failed. */
export interface Run {
  begun: Promise<void>;
  ended: Promise<{ ok: boolean }>;
}

/** What a session's transcript says: its growth since its first turn (the fresh-session rule), and its last turn's tokens. */
export interface Usage {
  grownBy: number;
  tokensCached: number;
  tokensIn: number;
  tokensOut: number;
}

/** What the desk gives a session it starts or wakes: the agent, where it runs, its model, and its door (its MCP address; the key is the runtime's env). */
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
  /** How long a launched run may take to begin (`Run.begun`) before the desk stops it: past it, a first turn is not started. */
  beginWithinMs: number;
  /** Why the program can't run now (not installed, not answering); none when it can: the same meaning as `SendPath.block`. */
  block: () => Promise<string | undefined>;
  /** Whether the session's own record shows its current run's model answering: what a restart reads, never a process alone. */
  hasBegun: (ref: string) => Promise<boolean>;
  /** Launches `message` in the session now, answering once the run is launched (`Run.begun` says when the turn is under way); refused while anything else runs it. */
  send: (agent: Agent, ref: string, message: string) => Promise<Run>;
  /** Starts a session in `agent.folder` with `brief` as its first message, answering once its run is launched: its ref, and a link that opens it. */
  start: (
    agent: Agent,
    brief: string
  ) => Promise<Run & { link: string; ref: string }>;
  /** Whether the session runs a turn now (the desk's or his), is idle, or is no longer known (deleted, archived). */
  state: (ref: string) => Promise<"running" | "idle" | "gone">;
  /** Stops the desk's own run of the session, if one runs (never his app's process), and forgets that run's records. */
  stop: (ref: string) => Promise<void>;
  /** The session's usage, or null when it can't say (a wake then sends into it). */
  usage: (ref: string) => Promise<Usage | null>;
}

/** A first answer in this long is a run that hangs (a door that never connects, a stuck update): the runtimes' begin limit. */
export const BEGIN_WITHIN_MS = 5 * MIN;

/**
 * The program the desk launches for a CLI: found on the PATH as it is now (`cliEnv`), less any `node_modules/.bin` (where
 * `bun run` puts Life's own pinned Codex, which is not his); the bare name when none is found.
 */
export function programOf(name: string) {
  const path = (cliEnv().PATH ?? "")
    .split(":")
    .filter((d) => !d.endsWith("node_modules/.bin"))
    .join(":");
  return Bun.which(name, { PATH: path }) ?? name;
}

/** `Runtime.block` for a CLI: why `<program> --version` fails, none when it answers. */
export async function cliBlockOf(program: string) {
  const r = await exec([programOf(program), "--version"], {
    env: cliEnv(),
    timeout: 5000,
  });
  return r.code === 0
    ? undefined
    : `${program} --version failed: ${r.stderr.slice(-200) || r.code}`;
}

const BEGUN_POLL_MS = 250;

/**
 * Settles when `isBegun` says the turn is under way: looked at again whenever the run's own record (`watched`, a file
 * once it exists) changes, the poll as a fallback; once the run has ended it is looked at once more before giving up.
 * Rejects when the run ended without it.
 */
export async function begunWhen(
  ended: Promise<unknown>,
  isBegun: () => boolean,
  watched: () => string | undefined
) {
  let isOver = false;
  let wake: () => void = () => undefined;
  const over = () => {
    isOver = true;
    wake();
  };
  ended.then(over, over);
  let watcher: FSWatcher | undefined;
  try {
    for (;;) {
      const wasOver = isOver;
      if (isBegun()) {
        return;
      }
      if (wasOver) {
        throw new Error("its process ended before the turn began");
      }
      const path = watcher ? undefined : watched();
      try {
        watcher = path ? watch(path, () => wake()) : watcher;
      } catch {
        // gone again: the poll looks
      }
      // biome-ignore lint/performance/noAwaitInLoops: waits for the run's own record to change
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, BEGUN_POLL_MS);
      });
    }
  } finally {
    watcher?.close();
  }
}

/** Stops the processes whose command line matches `pattern` (the desk's own run of a session); none running is fine. */
export async function stopMatching(pattern: string) {
  const { code, stderr } = await exec(["pkill", "-f", pattern]);
  if (code !== 0 && code !== 1) {
    throw new Error(`pkill: ${stderr}`);
  }
}

/** Whether some process holds session `ref` (its id is in the command line): the desk's turn, his, or an app's warm one. */
export async function isHeld(ref: string) {
  const { code, stderr } = await exec(["pgrep", "-f", ref]);
  // 1: no process; anything else (-1: pgrep could not start) is no answer, never "free".
  if (code !== 0 && code !== 1) {
    throw new Error(`pgrep: ${stderr}`);
  }
  return code === 0;
}
