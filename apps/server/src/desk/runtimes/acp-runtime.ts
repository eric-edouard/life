import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  type NewSessionRequest,
  ndJsonStream,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import { log } from "../../core/log";
import { errorOf, fromModel } from "../../core/log-line";
import { cliEnv } from "../../core/platform";
import type { Run, RunEnd, Runtime, Usage } from "./contract";
import type { Row } from "./runtime-rows";

// The one runtime: a row's program (`runtime-rows.ts`) driven over the Agent Client Protocol (the ACP runtime spec, 19 Nov
// 2026). One adapter process per turn, closed when the prompt's reply arrives: a turn is one run, his app may open the
// session between turns, and nothing is kept alive. Nothing is written to disk: `live` holds the runs this process drives,
// and a desk restart ends a running turn (its adapter dies with its pipe), which the desk's retry covers.
// This file names no runtime: what differs is in the row.

/** Everything from the spawn to the prompt being sent must finish within this, else the adapter is killed and the launch fails. */
export const LAUNCH_WITHIN_MS = 30_000;
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

/** A run this process drives: its end, and a way to stop it. */
interface Active {
  ended?: Promise<RunEnd>;
  stop: () => Promise<void>;
}

export function acpRuntime(row: Row, launchWithin = LAUNCH_WITHIN_MS): Runtime {
  const live = new Map<string, Active>();

  /**
   * Spawns the adapter in `a.folder`, makes or resumes the session, sets its model and effort and sends `message`: all within
   * `launchWithin`. The session is in `live` from the first synchronous step when it is resumed, else once it exists.
   */
  async function launch(
    a: Parameters<Runtime["send"]>[0],
    message: string,
    resume?: string
  ) {
    const active: Active = { stop: () => Promise.resolve() };
    if (resume) {
      live.set(resume, active);
    }
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
    let isPrompted = false;
    let first: number | null = null;
    let last: number | null = null;
    let beginOk: () => void = () => undefined;
    let beginFail: (e: Error) => void = () => undefined;
    const begun = new Promise<void>((ok, fail) => {
      beginOk = ok;
      beginFail = fail;
    });
    begun.catch(() => undefined);
    const conn = client({ name: "life-desk" })
      .onNotification(methods.client.session.update, ({ params }) => {
        const u = params.update;
        if (u.sessionUpdate === "tool_call") {
          titles.set(u.toolCallId, u.title);
        }
        // Only what arrives after the prompt: the resume's own updates and replays are not this run's.
        if (!isPrompted) {
          return;
        }
        if (u.sessionUpdate === "usage_update") {
          first ??= u.used;
          last = u.used;
        }
        if (ANSWERS.includes(u.sessionUpdate)) {
          beginOk();
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
    active.stop = async () => {
      if (!isPrompted) {
        child.kill("SIGKILL"); // still launching: the launch fails
        return;
      }
      await conn.agent.notify(methods.agent.session.cancel, { sessionId: ref });
      const timer = setTimeout(() => child.kill("SIGKILL"), EXIT_WITHIN_MS);
      await active.ended?.finally(() => clearTimeout(timer));
    };
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
        live.set(ref, active);
      }
      await setOptions(ref);
      isPrompted = true;
      const prompt = conn.agent.request(methods.agent.session.prompt, {
        prompt: [{ text: message, type: "text" }],
        sessionId: ref,
      });
      prompt.catch(() => undefined);
      // Wrapped: an async function returning a promise would wait for the reply, which is the turn's end.
      return { prompt };
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
    let prompt: Promise<PromptResponse>;
    try {
      ({ prompt } = await Promise.race([setup, late, notStarted]));
    } catch (error) {
      child.kill("SIGKILL");
      await close();
      live.delete(ref);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const ended = (async (): Promise<RunEnd> => {
      let end: RunEnd;
      // A stop the agent gave is a code word, logged as is; a thrown error is the runtime's, logged by its type only.
      let logged: Record<string, unknown> = {};
      try {
        const reply = await prompt;
        // What the adapter sent before its reply may still be on its way to the handlers.
        await Bun.sleep(0);
        const u = (reply as { usage?: PromptUsage | null }).usage;
        const usage: Usage | undefined = u
          ? {
              contextFirst: first,
              contextLast: last,
              tokensCached: u.cachedReadTokens ?? 0,
              tokensIn: (u.inputTokens ?? 0) + (u.cachedWriteTokens ?? 0),
              tokensOut: u.outputTokens ?? 0,
            }
          : undefined;
        end = OK_STOPS.includes(reply.stopReason)
          ? { ok: true, usage }
          : { ok: false, why: reply.stopReason };
        logged = { error: reply.stopReason };
      } catch (error) {
        end = { ok: false, why: whyOf(error) };
        logged = errorOf(fromModel(error));
      }
      beginFail(new Error(end.why ?? "it ended before the turn began"));
      await close();
      live.delete(ref);
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
    active.ended = ended;
    return { begun, ended, ref } satisfies Run & { ref: string };
  }

  const runtime: Runtime = {
    block: row.block,
    async send(a, ref, message) {
      // A turn running beside his would branch the conversation. After the awaited read, `live` is looked at again and
      // set in the same synchronous step (`launch`'s first), so two sends can't both pass.
      if (
        live.has(ref) ||
        (await runtime.state(ref)) === "running" ||
        live.has(ref)
      ) {
        throw new Error(`session ${ref} is running`);
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
  };
  return runtime;
}
