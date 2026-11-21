import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  type NewSessionRequest,
  ndJsonStream,
  type PromptResponse,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { MIN } from "../../core/clock";
import { log } from "../../core/log";
import { errorOf, fromModel } from "../../core/log-line";
import { cliEnv } from "../../core/platform";
import {
  type Run,
  type RunEnd,
  type Runtime,
  SessionLive,
  type Update,
  type Usage,
} from "./contract";
import type { Row } from "./runtime-rows";

// The one runtime: a row's program (`runtime-rows.ts`) driven over the Agent Client Protocol (the ACP runtime spec, 19 Nov
// 2026). One adapter process per turn, closed when the prompt's reply arrives: a turn is one run, his app may open the
// session between turns. The one exception is `talk` (the main session, Tell Life): its process is kept open across
// prompts, so his next words pay no start, and closed after `KEEP_WARM_MS` without one. Nothing is written to disk: `live` holds the runs this process drives,
// and a desk restart ends a running turn (its adapter dies with its pipe), which the desk's retry covers.
// This file names no runtime: what differs is in the row.

/** Everything from the spawn to the prompt being sent must finish within this, else the adapter is killed and the launch fails. */
export const LAUNCH_WITHIN_MS = 30_000;
/** How long a session kept open by `talk` or `keep` stays open without a prompt (the study's presence, 21 Nov 2026). */
const KEEP_WARM_MS = 5 * MIN;
/** A closed run's adapter has this long to exit before it is killed. */
const EXIT_WITHIN_MS = 5000;
/** The stop reasons of a turn that ran its course; anything else (`cancelled`, `refusal`) is a failed turn. */
const OK_STOPS = ["end_turn", "max_tokens", "max_turn_requests"];
/** The updates that show the model answered the prompt. */
const ANSWERS = ["agent_message_chunk", "agent_thought_chunk", "tool_call"];

/** A tool's bare name: what follows the door's prefix in the title of one of its calls. */
const BARE_TOOL = /^\w+$/;

/** A prompt reply's `usage` (ACP's unstable schema: an adapter that gives none leaves it out). */
interface PromptUsage {
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
  inputTokens?: number;
  outputTokens?: number;
}

/** An error's words: a JSON-RPC error's `message` is generic ("Internal error"), its `data.details` says what happened. */
const whyOf = (error: unknown) => {
  const e = error as Error & { data?: { details?: string } };
  return e.data?.details ? `${e.message}: ${e.data.details}` : e.message;
};

/** A run this process drives, or a session it keeps open (`talk`): a way to stop it. */
interface Active {
  stop: () => Promise<void>;
}

/** One adapter process on one session (`open`): a prompt at a time on it, until `close`. */
interface Connection {
  close: () => Promise<void>;
  /** Settles when the adapter's process is gone. */
  exited: Promise<void>;
  /** Sends `message` as one run on the session; `onUpdate` hears what its model says and does. */
  prompt: (message: string, onUpdate?: (u: Update) => void) => Run;
  ref: string;
  /** Cancels the running prompt and waits for its end, its process killed after `EXIT_WITHIN_MS`; still launching, the process is killed. */
  stop: () => Promise<void>;
}

/**
 * A prompt's reply as its run's end, with the context its usage updates showed (`heard`), and what a failed one logs: a
 * stop the agent gave is a code word, logged as is; a thrown error is the runtime's, logged by its type only.
 */
async function endOf(
  reply: Promise<PromptResponse>,
  heard: { first: number | null; last: number | null }
): Promise<{ end: RunEnd; logged: Record<string, unknown> }> {
  try {
    const r = await reply;
    // What the adapter sent before its reply may still be on its way to the handlers.
    await Bun.sleep(0);
    const u = (r as { usage?: PromptUsage | null }).usage;
    const usage: Usage | undefined = u
      ? {
          contextFirst: heard.first,
          contextLast: heard.last,
          tokensCached: u.cachedReadTokens ?? 0,
          tokensIn: (u.inputTokens ?? 0) + (u.cachedWriteTokens ?? 0),
          tokensOut: u.outputTokens ?? 0,
        }
      : undefined;
    return {
      end: OK_STOPS.includes(r.stopReason)
        ? { ok: true, usage }
        : { ok: false, why: r.stopReason },
      logged: { error: r.stopReason },
    };
  } catch (error) {
    return {
      end: { ok: false, why: whyOf(error) },
      logged: errorOf(fromModel(error)),
    };
  }
}

/** The run's updates as the desk hears them (`Update`): its words, that it thinks, and each tool call as it goes. */
function updateOf(
  u: SessionUpdate,
  titles: Map<string, string>
): Update | undefined {
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      return u.content.type === "text"
        ? { kind: "words", text: u.content.text }
        : undefined;
    case "agent_thought_chunk":
      return { kind: "thinking" };
    case "tool_call":
    case "tool_call_update":
      return {
        id: u.toolCallId,
        kind: "working",
        state: u.status ?? "pending",
        title: u.title ?? titles.get(u.toolCallId) ?? "",
      };
    default:
      return undefined;
  }
}

export function acpRuntime(
  row: Row,
  launchWithin = LAUNCH_WITHIN_MS,
  keepWarm = KEEP_WARM_MS
): Runtime {
  const live = new Map<string, Active>();
  /** The sessions kept open across prompts (`talk`), by agent, each closed after `KEEP_WARM_MS` without a prompt. */
  const kept = new Map<
    string,
    { c: Connection; isPrompting: boolean; timer?: Timer }
  >();

  /**
   * Spawns the adapter in `a.folder` and makes or resumes the session, its model, effort and mode set: all within
   * `launchWithin`, else the adapter is killed and the open fails.
   */
  async function open(
    a: Parameters<Runtime["send"]>[0],
    resume?: string
  ): Promise<Connection> {
    const { command, env } = await row.spawn(a);
    const child = spawn(command[0] ?? "", command.slice(1), {
      cwd: a.folder,
      // `LIFE_DESK_AGENT`: the resource sample sums the runtime and every tool it runs under its agent (`agentPidsOf`).
      env: { ...cliEnv(), ...env, LIFE_DESK_AGENT: a.id },
      // Its stderr goes to the desk's own process log (~/Library/Logs), never the event log: it quotes the agent.
      stdio: ["pipe", "pipe", "inherit"],
    });
    // A pipe closed under a write is the run's end, never a crash.
    child.stdin.on("error", () => undefined);
    // Bun fires `error` and never `exit` for a spawn that fails (a missing folder).
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    const notStarted = new Promise<never>((_, reject) =>
      child.once("error", reject)
    );
    const titles = new Map<string, string>();
    /** The prompt running now, and what it heard: only its updates count (a resume's replays are not a run's). */
    let current:
      | {
          first: number | null;
          last: number | null;
          onBegun: () => void;
          onUpdate?: (u: Update) => void;
        }
      | undefined;
    let isPrompted = false;
    const conn = client({ name: "life-desk" })
      .onNotification(methods.client.session.update, ({ params }) => {
        const u = params.update;
        if (u.sessionUpdate === "tool_call") {
          titles.set(u.toolCallId, u.title);
        }
        if (!current) {
          return;
        }
        if (u.sessionUpdate === "usage_update") {
          current.first ??= u.used;
          current.last = u.used;
        }
        if (ANSWERS.includes(u.sessionUpdate)) {
          current.onBegun();
        }
        const heard = current.onUpdate && updateOf(u, titles);
        if (heard) {
          current.onUpdate?.(heard);
        }
      })
      // An agent of his own Life: every ask is approved (the runtime's no-ask mode leaves few). A second Life's (a row
      // with `onlyDoorPrefix`): the door's tools alone are approved, every other ask refused, as `claude -p` and `codex exec` deny what would ask.
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        // Both adapters title a shell call with its command text: only the prefix and a bare tool name is the door's.
        const title = titles.get(params.toolCall.toolCallId) ?? "";
        const prefix = row.onlyDoorPrefix;
        const isAllowed =
          prefix === undefined ||
          (title.startsWith(prefix) &&
            BARE_TOOL.test(title.slice(prefix.length)));
        // `allow_once`; `allow_always` only when it is the one offered, since an adapter may keep it as a rule in his settings.
        const pick = isAllowed
          ? (params.options.find((o) => o.kind === "allow_once") ??
            params.options.find((o) => o.kind.startsWith("allow_")))
          : params.options.find((o) => o.kind === "reject_once");
        return {
          outcome: pick
            ? { optionId: pick.optionId, outcome: "selected" as const }
            : { outcome: "cancelled" as const },
        };
      })
      .connect(
        ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
        )
      );
    /**
     * Sets the session's model, effort and mode, in order, before the prompt. After every resume too: a resumed session
     * goes back to the program's default model, and takes the mode of whatever last touched it (his own turn in the
     * app), which would make a connector tool ask.
     */
    const setOptions = async (sessionId: string) => {
      for (const [configId, value] of [
        [row.config.model, a.model],
        [row.config.effort, a.effort],
        ["mode", row.mode],
      ] as const) {
        if (value) {
          try {
            // biome-ignore lint/performance/noAwaitInLoops: one option at a time, before the prompt
            await conn.agent.request(methods.agent.session.setConfigOption, {
              configId,
              sessionId,
              value,
            });
          } catch (error) {
            // A mode the adapter refuses is not fatal: its asks are approved all the same. The model and effort stay fatal.
            if (configId !== "mode") {
              throw fromModel(error);
            }
            log("desk.runtime", {
              agent: a.id,
              ...errorOf(fromModel(error)),
              ok: false,
              what: "mode",
            });
          }
        }
      }
    };
    const close = async () => {
      conn.close();
      child.stdin.end();
      await Promise.race([exited, Bun.sleep(EXIT_WITHIN_MS)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    };
    let ref = resume ?? "";
    let ended: Promise<RunEnd> | undefined;
    const setup = (async () => {
      await conn.agent.request(methods.agent.initialize, {
        clientCapabilities: {},
        clientInfo: { name: "life-desk", version: "1" },
        protocolVersion: 1,
      });
      const where: NewSessionRequest = {
        cwd: a.folder,
        mcpServers: [
          {
            headers: [{ name: "Authorization", value: row.header(a.door.key) }],
            name: "desk",
            type: "http" as const,
            url: a.door.url,
          },
        ],
        ...(row.meta ? { _meta: row.meta(a) } : {}),
      };
      if (resume) {
        await conn.agent.request(methods.agent.session.resume, {
          sessionId: resume,
          ...where,
        });
      } else {
        ref = (await conn.agent.request(methods.agent.session.new, where))
          .sessionId;
      }
      await setOptions(ref);
    })();
    setup.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `the adapter did not answer within ${launchWithin / 1000} s`
            )
          ),
        launchWithin
      );
    });
    try {
      await Promise.race([setup, late, notStarted]);
    } catch (error) {
      child.kill("SIGKILL");
      await close();
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const prompt = (message: string, onUpdate?: (u: Update) => void): Run => {
      let beginOk: () => void = () => undefined;
      let beginFail: (e: Error) => void = () => undefined;
      const begun = new Promise<void>((ok, fail) => {
        beginOk = ok;
        beginFail = fail;
      });
      begun.catch(() => undefined);
      const heard = { first: null, last: null, onBegun: beginOk, onUpdate };
      current = heard;
      isPrompted = true;
      const reply = conn.agent.request(methods.agent.session.prompt, {
        prompt: [{ text: message, type: "text" }],
        sessionId: ref,
      });
      reply.catch(() => undefined);
      ended = (async (): Promise<RunEnd> => {
        const { end, logged } = await endOf(reply, heard);
        if (current === heard) {
          current = undefined;
        }
        beginFail(new Error(end.why ?? "it ended before the turn began"));
        if (!end.ok) {
          log("desk.runtime", {
            agent: a.id,
            ...logged,
            ok: false,
            what: "turn",
          });
        }
        return end;
      })();
      return { begun, ended };
    };
    const stop = async () => {
      if (!isPrompted) {
        child.kill("SIGKILL"); // still launching: the launch fails
        return;
      }
      await conn.agent.notify(methods.agent.session.cancel, { sessionId: ref });
      const kill = setTimeout(() => child.kill("SIGKILL"), EXIT_WITHIN_MS);
      await ended?.finally(() => clearTimeout(kill));
    };
    return { close, exited, prompt, ref, stop };
  }

  /**
   * One run on a session of its own process (`send`, `start`): the process is closed when the run ends, so his app may
   * open the session between turns. A resumed session is in `live` from the first synchronous step, else once it exists.
   */
  async function launch(
    a: Parameters<Runtime["send"]>[0],
    message: string,
    resume?: string
  ) {
    let c: Connection | undefined;
    let isStopped = false;
    const active: Active = {
      stop: () => {
        isStopped = !c;
        return c?.stop() ?? Promise.resolve();
      },
    };
    if (resume) {
      live.set(resume, active);
    }
    try {
      c = await open(a, resume);
      if (isStopped) {
        await c.close();
        throw new Error("stopped while it launched"); // still launching: the launch fails
      }
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

  /** Closes agent `id`'s kept session once it has had no prompt for `keepWarm`. */
  const keepFor = (id: string) => {
    const k = kept.get(id);
    if (!k) {
      return;
    }
    clearTimeout(k.timer);
    k.timer = setTimeout(() => {
      if (!k.isPrompting) {
        kept.delete(id);
        live.delete(k.c.ref);
        k.c.close().catch(() => undefined);
      }
    }, keepWarm);
  };

  /**
   * Agent `a`'s kept session on `ref` (a new one when null), opened when none is kept: a session live elsewhere is
   * refused as `send` refuses it, before any process of its own runs it. A kept session on another ref is closed first.
   */
  async function keptOf(a: Parameters<Runtime["send"]>[0], ref: string | null) {
    const k = kept.get(a.id);
    if (k && (ref === null || k.c.ref === ref)) {
      return k;
    }
    if (k) {
      kept.delete(a.id);
      live.delete(k.c.ref);
      await k.c.close();
    }
    if (ref && (live.has(ref) || (await runtime.state(ref)) === "running")) {
      throw new SessionLive(`session ${ref} is running`);
    }
    const c = await open(a, ref ?? undefined);
    const made: { c: Connection; isPrompting: boolean; timer?: Timer } = {
      c,
      isPrompting: false,
    };
    kept.set(a.id, made);
    live.set(c.ref, {
      stop: async () => {
        await c.stop();
        kept.delete(a.id);
        live.delete(c.ref);
        await c.close();
      },
    });
    // A process that dies (a crash, a kill) is no longer kept: the next talk opens another.
    c.exited.then(() => {
      if (kept.get(a.id) === made) {
        kept.delete(a.id);
        live.delete(c.ref);
      }
    });
    return made;
  }

  const runtime: Runtime = {
    block: row.block,
    async keep(a, ref) {
      await keptOf(a, ref);
      keepFor(a.id);
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
        // The first turn's end waits for the hand-off, so no next turn runs beside it.
        ended: ended.then(async (end) => {
          await row.handOff?.(a, ref);
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
      if (k.isPrompting) {
        throw new SessionLive(`session ${k.c.ref} is answering`);
      }
      k.isPrompting = true;
      clearTimeout(k.timer);
      const run = k.c.prompt(message, onUpdate);
      const ended = run.ended.then((end) => {
        k.isPrompting = false;
        keepFor(a.id);
        return end;
      });
      return { begun: run.begun, ended, link: row.link(k.c.ref), ref: k.c.ref };
    },
  };
  return runtime;
}
