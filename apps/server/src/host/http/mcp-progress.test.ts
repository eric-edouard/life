import { expect, test } from "bun:test";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

// The SDK's per-request transport is `auto`: one JSON body, unless the handler emits a related message before its
// result, then SSE. `report` (`mcp-tool.ts`) relies on it; only 2026-07-28 exchanges exist in this SDK (the 2025
// protocol version is refused with 400), so this is the one leg.

const META = {
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "phone", version: "1" },
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
};

test("the SDK streams notifications/progress over SSE on a tools/call that carries a token, and one JSON body without", async () => {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "t", version: "1" });
    server.registerTool(
      "steps",
      { description: "d", inputSchema: z.object({}) },
      async (_args, ctx) => {
        const progressToken = ctx.mcpReq._meta?.progressToken;
        if (progressToken !== undefined) {
          for (const progress of [1, 2]) {
            // biome-ignore lint/performance/noAwaitInLoops: the steps go in order
            await ctx.mcpReq.notify({
              method: "notifications/progress",
              params: { message: `step ${progress}`, progress, progressToken },
            });
          }
        }
        return { content: [{ text: "done", type: "text" as const }] };
      }
    );
    return server;
  });
  const call = async (meta: object) => {
    const res = await handler.fetch(
      new Request("https://life.example.test/mcp", {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { _meta: { ...META, ...meta }, arguments: {}, name: "steps" },
        }),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "steps",
          "mcp-protocol-version": "2026-07-28",
        },
        method: "POST",
      })
    );
    const body = await res.text();
    return {
      events: body
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5))),
      type: res.headers.get("content-type") ?? "",
    };
  };
  const streamed = await call({ progressToken: "t1" });
  expect(streamed.type).toStartWith("text/event-stream");
  expect(streamed.events.map((e) => e.method ?? "result")).toEqual([
    "notifications/progress",
    "notifications/progress",
    "result",
  ]);
  expect(streamed.events[0].params.progressToken).toBe("t1");
  const plain = await call({});
  expect(plain.type).toStartWith("application/json");
  expect(plain.events).toEqual([]);
});
