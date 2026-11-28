import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  type NewSessionRequest,
  ndJsonStream,
  type PromptResponse,
  RequestError,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { log } from "../../core/log";
import { errorOf, fromModel } from "../../core/log-line";
import {
  connectorReadsOf,
  isSecondLifeReading,
} from "./connector-reads-server";
import {
  READS_SERVER,
  type Run,
  type RunEnd,
  type Runtime,
  type Update,
  type Usage,
} from "./contract";
import { providerPause } from "./provider-pause";
import type { Row } from "./runtime-rows";
import {
  LAUNCH_WITHIN_MS,
  type Open,
  sessionRuntime,
  spawnFor,
} from "./session-runtime";

// The ACP connection (`Open`, `session-runtime.ts`): a row's program (`runtime-rows.ts`) driven over the Agent Client
// Protocol (the ACP runtime spec, 19 Nov 2026): one adapter process on one session. This file names no runtime: what
// differs is in the row.

/**
 * The connector's reads (`connectorReadsOf`) as an ACP stdio server: started in its own folder by `sh` (an ACP server
 * names no folder), its secrets left to the adapter's environment (the row's), never in the server's description.
 */
const readsServerOf = () => {
  const r = connectorReadsOf();
  return {
    args: ["-c", 'cd "$0" && exec "$@"', r.cwd, r.command, ...r.args],
    command: "/bin/sh",
    env: Object.entries(r.env).map(([name, value]) => ({ name, value })),
    name: READS_SERVER,
  };
};

/** The stop reasons of a turn that ran its course; anything else (`cancelled`, `refusal`) is a failed turn. */
const OK_STOPS = ["end_turn", "max_tokens", "max_turn_requests"];
/** The updates that show the model answered the prompt. */
const ANSWERS = ["agent_message_chunk", "agent_thought_chunk", "tool_call"];

/** A tool's bare name: what follows an allowed prefix in the title of one of its calls. */
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

/**
 * A prompt's reply as its run's end, with the context its usage updates showed (`heard`), and what a failed one logs: a
 * stop the agent gave is a code word, logged as is; a thrown error is the runtime's, logged by its type only. `isAnswered`:
 * the adapter answered the prompt with an error (its provider's, like a spend limit), not a connection that closed.
 */
async function endOf(
  reply: Promise<PromptResponse>,
  heard: { first: number | null; last: number | null }
): Promise<{
  end: RunEnd;
  isAnswered?: boolean;
  logged: Record<string, unknown>;
}> {
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
      isAnswered: error instanceof RequestError,
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

/**
 * Spawns the adapter in `a.folder` and makes or resumes the session, its model, effort and mode set: all within
 * `launchWithin`, else the adapter is killed and the open fails. Each prompt's end is told to the provider's `pause`.
 */
const openOf =
  (
    row: Row,
    launchWithin: number,
    pause: ReturnType<typeof providerPause>
  ): Open =>
  async (a, resume, opening, isAsk) => {
    const { command, env } = await row.spawn(a);
    const {
      child,
      close: closeProcess,
      exited,
      stopping,
    } = spawnFor(a, command, env, opening);
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
      // with `onlyToolPrefixes`): its door's and its reads' tools alone are approved, every other ask refused, as
      // `claude -p` and `codex exec` deny what would ask.
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        // Both adapters title a shell call with its command text: only a prefix and a bare tool name is an allowed tool.
        const title = titles.get(params.toolCall.toolCallId) ?? "";
        const prefixes = row.onlyToolPrefixes;
        const isAllowed =
          prefixes === undefined ||
          prefixes.some(
            (p) => title.startsWith(p) && BARE_TOOL.test(title.slice(p.length))
          );
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
      await closeProcess();
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
          // A second Life's agent reads its own Life through the connector's reads; his own reads through his connectors.
          ...(row.onlyToolPrefixes && isSecondLifeReading()
            ? [readsServerOf()]
            : []),
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
        const { end, isAnswered, logged } = await endOf(reply, heard);
        // A good run lifts the pause; a background turn the adapter answered with an error grows it (his own ask's
        // never does); a closed connection (a stop, a crash) says nothing.
        if (end.ok || (isAnswered && !isAsk)) {
          pause.heard(!end.ok);
        }
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
        return; // nothing runs on it
      }
      await conn.agent.notify(methods.agent.session.cancel, { sessionId: ref });
      await stopping(ended);
    };
    return { close, exited, prompt, ref, stop };
  };

/**
 * A row's runtime over ACP: the one runtime (`sessionRuntime`) with ACP's connection, its background turns paused while
 * its provider fails (`provider-pause.ts`, one pause for every agent of the row, as pi's).
 */
export const acpRuntime = (
  row: Row,
  launchWithin = LAUNCH_WITHIN_MS,
  keepWarm?: number
): Runtime => {
  const pause = providerPause();
  return {
    ...sessionRuntime(row, openOf(row, launchWithin, pause), keepWarm),
    paused: pause.block,
  };
};
