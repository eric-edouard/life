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
    const { command, env } = row.spawn(a);
    const child = spawn(command[0] ?? "", command.slice(1), {
      cwd: a.folder,
      env: { ...cliEnv(), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr = `${stderr}${d}`.slice(-300);
    });
    // A pipe closed under a write is the run's end, never a crash.
    child.stdin.on("error", () => undefined);
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve())
    );
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
      // The door's tools are approved; every other ask is refused, as `claude -p` and `codex exec` deny what would ask.
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        const isDoor = (
          titles.get(params.toolCall.toolCallId) ?? ""
        ).startsWith(row.doorPrefix);
        const pick = params.options.find(
          (o) => o.kind === (isDoor ? "allow_once" : "reject_once")
        );
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
        ...(row.meta ? { _meta: row.meta } : {}),
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
      // Set after every resume too: a resumed session goes back to the program's default model.
      for (const [configId, value] of [
        [row.config.model, a.model],
        [row.config.effort, a.effort],
      ] as const) {
        if (value) {
          // biome-ignore lint/performance/noAwaitInLoops: one option at a time, before the prompt
          await conn.agent.request(methods.agent.session.setConfigOption, {
            configId,
            sessionId: ref,
            value,
          });
        }
      }
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
      } catch (error) {
        end = { ok: false, why: whyOf(error) };
      }
      beginFail(new Error(end.why ?? "it ended before the turn began"));
      await close();
      live.delete(ref);
      if (!end.ok) {
        log("desk.runtime", {
          agent: a.id,
          error: `${end.why}: ${stderr}`.slice(-300),
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
