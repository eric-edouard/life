import { spawn } from "node:child_process";
import { MIN } from "../../core/clock";
import { cliEnv } from "../../core/platform";
import {
  type Agent,
  type Run,
  type Runtime,
  SessionLive,
  type Update,
} from "./contract";
import type { Row } from "./runtime-rows";

// The one runtime (`contract.ts`): runs, warm sessions and the live map over a connection that one program process holds
// on one session (`Connection`), opened by the runtime's own protocol (`Open`: ACP's in `acp-runtime.ts`, pi's RPC in
// `pi-runtime.ts`). One process per turn, closed when the run ends: a turn is one run, his app may open the session
// between turns. The one exception is `talk` (the main session, Ask Life): its process is kept open across prompts, so
// his next words pay no start, and closed after `KEEP_WARM_MS` without one. Nothing is written to disk: `live` holds the
// runs this process drives, and a desk restart ends a running turn (its process dies with its pipe), which the desk's
// retry covers. This file names no runtime and no protocol.

/** Everything from the spawn to the prompt being sent must finish within this, else the process is killed and the launch fails. */
export const LAUNCH_WITHIN_MS = 30_000;
/** How long a session kept open by `talk` or `keep` stays open without a prompt (the study's presence, 21 Nov 2026). */
const KEEP_WARM_MS = 5 * MIN;
/** A closed run's process has this long to exit before it is killed. */
export const EXIT_WITHIN_MS = 5000;

/** A run this process drives, or a session it keeps open (`talk`): a way to stop it. */
interface Active {
  stop: () => Promise<void>;
}

/** A way to kill an adapter while `open` runs: a kill asked before its spawn kills it at its spawn. */
export interface Opening {
  isKilled: boolean;
  kill: () => void;
}
export const openingOf = (): Opening => {
  const o: Opening = {
    isKilled: false,
    kill: () => {
      o.isKilled = true;
    },
  };
  return o;
};

/** A session kept open across prompts (`talk`, `keep`), reserved in `kept` and `live` before it opens (`ready`). */
interface Kept {
  active: Active;
  c?: Connection;
  id: string;
  isPrompting: boolean;
  opening: Opening;
  ready: Promise<Connection>;
  ref?: string;
  timer?: Timer;
}

/** One adapter process on one session (`open`): a prompt at a time on it, until `close`. */
export interface Connection {
  close: () => Promise<void>;
  /** Settles when the adapter's process is gone. */
  exited: Promise<void>;
  /** Sends `message` as one run on the session; `onUpdate` hears what its model says and does. */
  prompt: (message: string, onUpdate?: (u: Update) => void) => Run;
  ref: string;
  /** Cancels the running prompt and waits for its end, its process killed after `EXIT_WITHIN_MS`; never prompted, nothing. */
  stop: () => Promise<void>;
}

/**
 * A runtime's process for agent `a`'s session, in its folder: a stop while it opens kills it (the open fails); `exited`
 * settles when it is gone; `close` ends its input and kills it past `EXIT_WITHIN_MS`; `stopping` waits for a stopped
 * run's end and kills it past `EXIT_WITHIN_MS`.
 */
export function spawnFor(
  a: Agent,
  command: string[],
  env: Record<string, string>,
  opening: Opening
) {
  const child = spawn(command[0] ?? "", command.slice(1), {
    cwd: a.folder,
    // `LIFE_DESK_AGENT`: the resource sample sums the runtime and every tool it runs under its agent (`agentPidsOf`).
    env: { ...cliEnv(), ...env, LIFE_DESK_AGENT: a.id },
    // Its stderr goes to the desk's own process log (~/Library/Logs), never the event log: it quotes the agent.
    stdio: ["pipe", "pipe", "inherit"],
  });
  opening.kill = () => {
    opening.isKilled = true;
    child.kill("SIGKILL");
  };
  if (opening.isKilled) {
    child.kill("SIGKILL");
  }
  // A pipe closed under a write is the run's end, never a crash.
  child.stdin.on("error", () => undefined);
  // Bun fires `error` and never `exit` for a spawn that fails (a missing folder).
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const close = async () => {
    child.stdin.end();
    await Promise.race([exited, Bun.sleep(EXIT_WITHIN_MS)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  };
  const stopping = async (ended: Promise<unknown> | undefined) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), EXIT_WITHIN_MS);
    await ended?.finally(() => clearTimeout(kill));
  };
  return { child, close, exited, stopping };
}

/** What the one runtime reads of a runtime's row: whether it can run, a session's state when no run of the desk holds it, its link, its open on his Mac. */
export type SessionRow = Pick<
  Row,
  "block" | "continueOnMac" | "link" | "readSessionState"
>;

/** Opens a process on session `resume` (none: a new one) for agent `a`; `opening.kill` kills it while it opens. */
export type Open = (
  a: Agent,
  resume: string | undefined,
  opening: Opening
) => Promise<Connection>;

export function sessionRuntime(
  row: SessionRow,
  open: Open,
  keepWarm = KEEP_WARM_MS
): Runtime {
  const live = new Map<string, Active>();
  /** The sessions kept open across prompts (`talk`), by agent, each closed after `KEEP_WARM_MS` without a prompt. */
  const kept = new Map<string, Kept>();

  /**
   * One run on a session of its own process (`send`, `start`): the process is closed when the run ends, so his app may
   * open the session between turns. A resumed session is in `live` from the first synchronous step, else once it exists.
   */
  async function launch(a: Agent, message: string, resume?: string) {
    let c: Connection | undefined;
    const opening = openingOf();
    const active: Active = {
      stop: () => {
        if (c) {
          return c.stop();
        }
        opening.kill(); // still launching: the launch fails
        return Promise.resolve();
      },
    };
    if (resume) {
      live.set(resume, active);
    }
    try {
      c = await open(a, resume, opening);
    } catch (error) {
      live.delete(resume ?? "");
      throw error;
    }
    live.set(c.ref, active);
    const run = c.prompt(message);
    const opened = c;
    const ended = run.ended.then(async (end) => {
      await opened.close();
      live.delete(opened.ref);
      return end;
    });
    return { begun: run.begun, ended, ref: c.ref };
  }

  /** Forgets kept session `k`, if it is still the one kept: its timer, its place in `kept` and in `live`. */
  const forget = (k: Kept) => {
    clearTimeout(k.timer);
    if (kept.get(k.id) === k) {
      kept.delete(k.id);
    }
    if (k.ref && live.get(k.ref) === k.active) {
      live.delete(k.ref);
    }
  };

  /** Closes kept session `k`: forgotten first, its prompt stopped, its process closed (killed while it opens). */
  const closeKept = async (k: Kept) => {
    forget(k);
    if (!k.c) {
      k.opening.kill();
      await k.ready.catch(() => undefined);
      return;
    }
    await k.c.stop();
    await k.c.close();
  };

  /** Closes kept session `k` once it has had no prompt for `keepWarm`. */
  const keepFor = (k: Kept) => {
    clearTimeout(k.timer);
    k.timer = setTimeout(() => {
      if (!k.isPrompting) {
        closeKept(k).catch(() => undefined);
      }
    }, keepWarm);
  };

  /**
   * Agent `a`'s kept session on `ref` (null: the one kept, else a new one), opened when none is kept. It is reserved in
   * `kept` and `live` in the same synchronous step as the checks, so a `send`, a `keep` or a `talk` racing it waits on
   * it or is refused; a session his app runs is refused, as `send` refuses it. A kept session on another ref is closed,
   * unless it is answering.
   */
  async function keptOf(a: Agent, ref: string | null) {
    const k = kept.get(a.id);
    if (k && (ref === null || k.ref === ref)) {
      await k.ready;
      return k;
    }
    if (k?.isPrompting) {
      throw new SessionLive(`session ${k.ref} is answering`);
    }
    if (ref && live.has(ref)) {
      throw new SessionLive(`session ${ref} is running`);
    }
    const made = {
      id: a.id,
      isPrompting: false,
      opening: openingOf(),
      ref: ref ?? undefined,
    } as Kept;
    made.active = { stop: () => closeKept(made) };
    kept.set(a.id, made);
    if (ref) {
      live.set(ref, made.active);
    }
    if (k) {
      closeKept(k).catch(() => undefined);
    }
    made.ready = (async () => {
      if (ref && (await row.readSessionState(ref)) === "running") {
        throw new SessionLive(`session ${ref} is running`);
      }
      const c = await open(a, ref ?? undefined, made.opening);
      made.c = c;
      made.ref = c.ref;
      if (kept.get(a.id) !== made) {
        await c.close();
        throw new SessionLive(`session ${c.ref} was closed while it opened`);
      }
      live.set(c.ref, made.active);
      // A process that dies (a crash, a kill) is no longer kept: the next talk opens another.
      c.exited.then(() => forget(made));
      return c;
    })();
    made.ready.catch(() => forget(made));
    await made.ready;
    return made;
  }

  const runtime: Runtime = {
    block: row.block,
    continueOnMac: row.continueOnMac,
    async keep(a, ref) {
      const k = await keptOf(a, ref);
      if (!k.isPrompting) {
        keepFor(k);
      }
    },
    async send(a, ref, message) {
      // A turn running beside his would branch the conversation. After the awaited read, `live` is looked at again and
      // set in the same synchronous step (`launch`'s first), so two sends can't both pass.
      if (
        live.has(ref) ||
        (await runtime.state(ref)) === "running" ||
        live.has(ref)
      ) {
        throw new SessionLive(`session ${ref} is running`);
      }
      return await launch(a, message, ref);
    },
    async start(a, brief) {
      const { begun, ended, ref } = await launch(a, brief);
      return { begun, ended, link: row.link(ref), ref };
    },
    state: (ref) =>
      live.has(ref) ? Promise.resolve("running") : row.readSessionState(ref),
    async stop(ref) {
      await live.get(ref)?.stop();
    },
    async talk(a, ref, message, onUpdate) {
      const k = await keptOf(a, ref);
      const { c } = k;
      // A stop between its open and here closed it: refused as a session not taken (the ask keeps no retry key).
      if (!c || k.isPrompting || kept.get(a.id) !== k) {
        throw new SessionLive(`session ${k.ref} is answering or closed`);
      }
      k.isPrompting = true;
      clearTimeout(k.timer);
      const run = c.prompt(message, onUpdate);
      const ended = run.ended.then((end) => {
        k.isPrompting = false;
        if (kept.get(k.id) === k) {
          keepFor(k);
        }
        return end;
      });
      return { begun: run.begun, ended, link: row.link(c.ref), ref: c.ref };
    },
  };
  return runtime;
}
