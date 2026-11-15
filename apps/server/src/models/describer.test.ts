import { afterAll, beforeAll, expect, test } from "bun:test";
import { describeAt } from "./describer";

let server: ReturnType<typeof Bun.serve>;
let last: unknown;

beforeAll(() => {
  server = Bun.serve({
    async fetch(req) {
      last = await req.json();
      const content =
        new URL(req.url).pathname === "/v1/chat/completions"
          ? "  Two people on a beach.  "
          : null;
      return Response.json({ choices: [{ message: { content } }] });
    },
    port: 0,
  });
});
afterAll(() => server.stop(true));

test("an image goes to the server as a data URI with the prompt, thinking off, and its words come back trimmed", async () => {
  const text = await describeAt(
    server.url.origin,
    new Uint8Array([1, 2, 3]),
    "Describe it."
  );
  expect(text).toBe("Two people on a beach.");
  const body = last as {
    chat_template_kwargs: unknown;
    messages: { content: { image_url?: { url: string }; text?: string }[] }[];
  };
  expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(body.messages[0]?.content[0]?.image_url?.url).toBe(
    "data:image/jpeg;base64,AQID"
  );
  expect(body.messages[0]?.content[1]?.text).toBe("Describe it.");
});

test("an empty answer or a refusal throws", async () => {
  const empty = Bun.serve({
    fetch: () => Response.json({ choices: [{ message: { content: " " } }] }),
    port: 0,
  });
  const down = Bun.serve({
    fetch: () => new Response("busy", { status: 503 }),
    port: 0,
  });
  try {
    await expect(
      describeAt(empty.url.origin, new Uint8Array(), "x")
    ).rejects.toThrow("no words");
    await expect(
      describeAt(down.url.origin, new Uint8Array(), "x")
    ).rejects.toThrow("503");
  } finally {
    empty.stop(true);
    down.stop(true);
  }
});
