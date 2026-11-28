import { spawn } from "node:child_process";
import { join } from "node:path";
import { MIN } from "../../core/clock";
import { log } from "../../core/log";
import {
  IS_COMPILED_HELPER,
  LIFE_CODE_DIR,
  LIFE_STATE_DIR,
} from "../../core/paths";
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
  /** Its agent, while its session is new: listed in his app (`listInApp`) once Life's process lets it go. ponytail: in memory, so a restart before that close drops this one listing. */
  agentToList?: Agent;
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
  /** Sets what holds on every request of the session (`Agent.inForce`); none: the runtime puts it ahead of each message. */
  inForce?: (text: string) => void;
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

/** What the one runtime reads of a runtime's row: whether it can run, a session's state when no run of the desk holds it, its link, its open on his Mac, its listing in his app. */
export type SessionRow = Pick<
  Row,
  "block" | "continueOnMac" | "link" | "listInApp" | "readSessionState"
>;

/**
 * Opens a process on session `resume` (none: a new one) for agent `a`; `opening.kill` kills it while it opens. `isAsk`:
 * it answers the owner (`talk`), so it thinks at an ask's effort when the agent names none.
 */
export type Open = (
  a: Agent,
  resume: string | undefined,
  opening: Opening,
  isAsk?: boolean
) => Promise<Connection>;

/** `message` as the session is sent it: on a runtime that adds `Agent.inForce` itself, as it is; else after it. */
function promptOf(c: Connection, a: Agent, message: string) {
  if (c.inForce) {
    c.inForce(a.inForce ?? "");
    return message;
  }
  return a.inForce ? `${a.inForce}\n\n${message}` : message;
}

/** Logs an ask's timings (`desk.runtime`, `what: "ask"`): to its first step, its first words and its whole answer, in ms; nothing waits on them. */
function timedAsk(agent: string, onUpdate: (u: Update) => void) {
  const at = performance.now();
  const ms = () => Math.round(performance.now() - at);
  let firstStepMs: number | undefined;
  let firstWordsMs: number | undefined;
  return {
    ended: (ok: boolean) =>
      log("desk.runtime", {
        agent,
        firstStepMs,
        firstWordsMs,
        ok,
        what: "ask",
        wholeMs: ms(),
      }),
    onUpdate: (u: Update) => {
      if (u.kind === "working") {
        firstStepMs ??= ms();
      }
      if (u.kind === "words") {
        firstWordsMs ??= ms();
      }
      onUpdate(u);
    },
  };
}

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
    const run = c.prompt(promptOf(c, a, message));
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
    // A new session is listed in his app once no process of Life's runs it, once (a resumed one is listed already).
    if (k.agentToList) {
      await row.listInApp?.(k.agentToList, k.c.ref);
    }
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
      // Only a session this call makes is new; one resumed was listed when it was.
      agentToList: ref === null ? a : undefined,
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
      // A kept session answers him (`talk`, `keep`): it thinks at an ask's effort.
      const c = await open(a, ref ?? undefined, made.opening, true);
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

  /** The kept session on `ref` while its talk runs. */
  const answeringOn = (ref: string) =>
    [...kept.values()].find((k) => k.ref === ref && k.isPrompting && k.c);

  const runtime: Runtime = {
    block: row.block,
    async cancel(ref) {
      await answeringOn(ref)?.c?.stop();
    },
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
      return {
        begun,
        // Listed in his app once Life's process closed it, before the turn ends, so no next turn opens beside the import.
        ended: ended.then(async (end) => {
          await row.listInApp?.(a, ref);
          return end;
        }),
        link: row.link(ref),
        ref,
      };
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
      const timed = timedAsk(a.id, onUpdate);
      const run = c.prompt(promptOf(c, a, message), timed.onUpdate);
      const ended = run.ended.then((end) => {
        timed.ended(end.ok);
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

/** What Life's reader of the connector needs from the desk's own environment beside Life's paths: the secrets its reads use and the test switch. */
const READER_ENV = ["GOG_KEYRING_PASSWORD", "LIFELOG_TOKEN", "NODE_ENV"];

/**
 * The connector's reads as a stdio MCP server (`life connector-reads`): the compiled helper itself in the app, the CLI's
 * entry in a checkout, with Life's paths (`LIFE_*`) and the secrets its reads use, values as they are. A runtime runs it
 * with its own environment beside this one, so the helper is told it is not bun (`BUN_BE_BUN`).
 */
export const connectorReadsOf = () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] =>
        e[1] !== undefined &&
        (e[0].startsWith("LIFE_") || READER_ENV.includes(e[0]))
    )
  );
  return {
    args: [
      ...(IS_COMPILED_HELPER
        ? []
        : [
            join(
              LIFE_CODE_DIR,
              "apps",
              "server",
              "src",
              "desk",
              "life-entry.ts"
            ),
          ]),
      "connector-reads",
    ],
    command: process.execPath,
    // Life's state, never the agent's folder: bun reads a folder's `.env` and `bunfig.toml` at start.
    cwd: LIFE_STATE_DIR,
    env: { ...env, BUN_BE_BUN: "" },
  };
};
