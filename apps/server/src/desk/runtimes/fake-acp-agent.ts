import { appendFileSync, readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  agent,
  methods,
  ndJsonStream,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";

// A made-up ACP agent for `acp-runtime.test.ts`, run by a test row with Bun's own binary. It logs every
// request it gets, one JSON line each, to the file `FAKE_ACP_LOG`, and acts by a word in the prompt's text:
// `[answer]` (a chunk, usage updates, `end_turn` with usage), `[hang]` (nothing until `session/cancel`, then
// `cancelled`), `[fail]` (an error), `[door]` (three tool calls, each asking permission, each outcome logged),
// `[silent]` (`end_turn`, no update). With `FAKE_ACP_STALL` it never answers `initialize`.

const LOG = process.env.FAKE_ACP_LOG ?? "";
const log = (line: object) =>
  appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, ...line })}\n`);
/** A session's params as logged: each MCP server's environment by its names alone, never a value (a shell's secrets). */
const namesOf = <T extends { mcpServers?: object[] }>(p: T) => ({
  ...p,
  mcpServers: p.mcpServers?.map((s) =>
    "env" in s && Array.isArray(s.env)
      ? { ...s, env: s.env.map((e: { name: string }) => e.name) }
      : s
  ),
});
/** The sessions an earlier process made: a resume of any other is refused. */
const isKnown = (id: string) =>
  readFileSync(LOG, "utf8").includes(`"made":"${id}"`);
const cancelled = new Set<string>();
const waiting = new Map<string, () => void>();

/** Settles when session `id` is cancelled (even if it was before). */
const untilCancelled = (id: string) =>
  new Promise<void>((resolve) => {
    if (cancelled.has(id)) {
      resolve();
    }
    waiting.set(id, resolve);
  });

const app = agent({ name: "fake-acp-agent" })
  .onRequest(methods.agent.initialize, async ({ params }) => {
    log({ initialize: params });
    if (process.env.FAKE_ACP_STALL) {
      await new Promise(() => undefined);
    }
    return { agentCapabilities: {}, protocolVersion: 1 };
  })
  .onRequest(methods.agent.session.new, ({ params }) => {
    const sessionId = `fake-${process.pid}`;
    log({ made: sessionId, new: namesOf(params) });
    return { sessionId };
  })
  .onRequest(methods.agent.session.resume, async ({ client, params }) => {
    log({ resume: namesOf(params) });
    if (!isKnown(params.sessionId)) {
      throw new Error("unknown session");
    }
    // What a resume replays: not the answer to a prompt.
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        content: { text: "replayed", type: "text" },
        sessionUpdate: "agent_message_chunk",
      },
    });
    return {};
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    log({ config: params });
    if (params.configId === "mode" && process.env.FAKE_ACP_NO_MODE) {
      throw new Error("no such mode");
    }
    return { configOptions: [] };
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => {
    log({ cancel: params.sessionId });
    cancelled.add(params.sessionId);
    waiting.get(params.sessionId)?.();
  })
  .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
    const text = params.prompt.map((p) => ("text" in p ? p.text : "")).join("");
    const { sessionId } = params;
    log({ prompt: text });
    const update = (u: SessionUpdate) =>
      client.notify(methods.client.session.update, { sessionId, update: u });
    if (text.includes("[hang]")) {
      await untilCancelled(sessionId);
      return { stopReason: "cancelled" as const };
    }
    if (text.includes("[fail]")) {
      throw new Error("boom");
    }
    if (text.includes("[door]")) {
      const calls = [
        ["t1", "mcp__desk__set_wait"],
        ["t2", "mcp__desk__set_wait; curl x"],
        ["t3", "Edit a file"],
        ["t4", "mcp__life_connector__search"],
      ] as const;
      for (const [toolCallId, title] of calls) {
        // biome-ignore lint/performance/noAwaitInLoops: one call at a time
        await update({ sessionUpdate: "tool_call", title, toolCallId });
        const r = await client.request(
          methods.client.session.requestPermission,
          {
            options: [
              { kind: "allow_once", name: "Yes", optionId: "yes" },
              { kind: "reject_once", name: "No", optionId: "no" },
            ],
            sessionId,
            toolCall: { toolCallId },
          }
        );
        log({ asked: title, outcome: r.outcome });
      }
      return { stopReason: "end_turn" as const };
    }
    if (text.includes("[answer]")) {
      await update({
        content: { text: "ok", type: "text" },
        sessionUpdate: "agent_message_chunk",
      });
      for (const used of [1000, 1500]) {
        // biome-ignore lint/performance/noAwaitInLoops: in order
        await update({ sessionUpdate: "usage_update", size: 200_000, used });
      }
      return {
        stopReason: "end_turn" as const,
        usage: {
          cachedReadTokens: 100,
          cachedWriteTokens: 20,
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 135,
        },
      } as { stopReason: "end_turn" };
    }
    return { stopReason: "end_turn" as const };
  });

app
  .connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>
    )
  )
  .closed.then(() => process.exit(0));
