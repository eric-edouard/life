import type { PiProvider } from "./pi-extension";

// A made-up OpenAI-shaped model provider for the pi tests (`pi-extension.test.ts`, `pi-runtime.test.ts`): each request
// is kept (`asked`, with its key) and answered by the test's `reply`, as one streamed assistant message: its words, its
// shell calls, or nothing until the request is aborted (`hang`). `providerOf` is Life's pi provider pointed at it.

/** One request the provider got: its `Authorization` and its body. */
export interface Asked {
  auth: string | null;
  body: { messages: unknown[]; provider?: unknown };
}

/** What the provider streams for one request. */
export type Reply = { calls: Call[] } | { text: string } | "hang";

/** A tool call the model asks for: a shell command, or another tool with its arguments. */
export type Call = string | { args: object; name: string };

const sse = (chunks: object[]) =>
  `${chunks.map((c) => `data: ${JSON.stringify({ choices: [], ...c })}\n\n`).join("")}data: [DONE]\n\n`;

/** The streamed message of `reply`: its words or its shell calls, then its stop and its tokens. */
const streamOf = (reply: Exclude<Reply, "hang">) => {
  const delta =
    "text" in reply
      ? { content: reply.text }
      : {
          tool_calls: reply.calls.map((c, index) => ({
            function:
              typeof c === "string"
                ? { arguments: JSON.stringify({ command: c }), name: "bash" }
                : { arguments: JSON.stringify(c.args), name: c.name },
            id: `c${index + 1}`,
            index,
            type: "function",
          })),
        };
  return sse([
    { choices: [{ delta: { role: "assistant", ...delta }, index: 0 }] },
    {
      choices: [
        {
          delta: {},
          finish_reason: "text" in reply ? "stop" : "tool_calls",
          index: 0,
        },
      ],
      usage: {
        completion_tokens: 2,
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    },
  ]);
};

export function fakePiProvider(reply: (n: number, a: Asked) => Reply) {
  const asked: Asked[] = [];
  const server = Bun.serve({
    async fetch(req) {
      if (!new URL(req.url).pathname.startsWith("/v1/")) {
        return new Response("not found", { status: 404 });
      }
      const a = {
        auth: req.headers.get("authorization"),
        body: (await req.json()) as Asked["body"],
      };
      asked.push(a);
      const r = reply(asked.length, a);
      if (r === "hang") {
        return new Response(
          new ReadableStream({
            start: (c) => req.signal.addEventListener("abort", () => c.close()),
          }),
          { headers: { "content-type": "text/event-stream" } }
        );
      }
      return new Response(streamOf(r), {
        headers: { "content-type": "text/event-stream" },
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const providerOf = (routing: object): PiProvider => ({
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    models: [
      {
        compat: { openRouterRouting: routing },
        contextWindow: 100_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "up",
        input: ["text"],
        maxTokens: 1000,
        name: "up",
        reasoning: false,
      },
    ],
  });
  return {
    asked,
    port: server.port,
    providerOf,
    stop: () => server.stop(true),
  };
}
