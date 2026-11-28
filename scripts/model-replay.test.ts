import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintOf, replayProxy } from "./model-replay";

const SSE = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const ask = (url: string, messages: unknown, extra = {}) =>
  fetch(`${url}/v1/messages?beta=true`, {
    body: JSON.stringify({ messages, model: "m", stream: true, ...extra }),
    method: "POST",
  });

test("a reply is recorded once, replayed without the provider, and a changed ask is refused in replay", async () => {
  let upstreamCalls = 0;
  const upstream = Bun.serve({
    fetch: () => {
      upstreamCalls += 1;
      return new Response(SSE, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    port: 0,
  });
  const file = join(mkdtempSync(join(tmpdir(), "replay-")), "recordings.jsonl");
  const words = [
    {
      content: [{ text: "Where do things stand?", type: "text" }],
      role: "user",
    },
  ];

  const record = replayProxy(
    file,
    "record",
    `http://127.0.0.1:${upstream.port}`
  );
  expect(await (await ask(record.url, words)).text()).toBe(SSE);
  expect(await (await ask(record.url, words)).text()).toBe(SSE);
  record.stop();
  expect(upstreamCalls).toBe(1);

  const replay = replayProxy(
    file,
    "replay",
    `http://127.0.0.1:${upstream.port}`
  );
  // Claude Code's own parts (system prompt, metadata, reminders) change nothing.
  const same = await ask(
    replay.url,
    [
      {
        content: [
          {
            text: "<system-reminder>Today is 1 March</system-reminder>\n",
            type: "text",
          },
          { text: "Where do things stand?", type: "text" },
        ],
        role: "user",
      },
    ],
    { metadata: { user_id: "another" }, system: "another prompt" }
  );
  expect(await same.text()).toBe(SSE);
  const changed = await ask(replay.url, [
    { content: "Who is Ana?", role: "user" },
  ]);
  expect(changed.status).toBe(599);
  replay.stop();
  upstream.stop(true);
  expect(upstreamCalls).toBe(1);
  expect(replay.misses).toHaveLength(1);
});

test("a fingerprint leaves out Claude Code's reminders, cache marks and built-in tools", () => {
  const plain = JSON.stringify({
    messages: [{ content: [{ text: "Hi", type: "text" }], role: "user" }],
    model: "m",
    tools: [{ name: "mcp__life_connector__search" }],
  });
  const dressed = JSON.stringify({
    messages: [
      {
        content: [
          { text: "<system-reminder>cwd /x</system-reminder>", type: "text" },
          { cache_control: { type: "ephemeral" }, text: "Hi", type: "text" },
        ],
        role: "user",
      },
    ],
    model: "m",
    system: "Claude Code 9.9",
    tools: [{ name: "Read" }, { name: "mcp__life_connector__search" }],
  });
  expect(fingerprintOf("POST", "/v1/messages", dressed)).toBe(
    fingerprintOf("POST", "/v1/messages", plain)
  );
});

test("a REST read is replayed by its method, path and query, its content type kept", async () => {
  const upstream = Bun.serve({
    fetch: (req) => Response.json({ path: new URL(req.url).search }),
    port: 0,
  });
  const file = join(mkdtempSync(join(tmpdir(), "replay-")), "recordings.jsonl");
  const record = replayProxy(
    file,
    "record",
    `http://127.0.0.1:${upstream.port}`
  );
  await fetch(`${record.url}/search?q=ana`);
  record.stop();
  upstream.stop(true);
  const replay = replayProxy(file, "replay", "http://127.0.0.1:9");
  const hit = await fetch(`${replay.url}/search?q=ana`);
  expect(hit.headers.get("content-type")).toContain("application/json");
  expect(await hit.json()).toEqual({ path: "?q=ana" });
  expect((await fetch(`${replay.url}/search?q=bo`)).status).toBe(599);
  replay.stop();
});
