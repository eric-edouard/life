import { afterAll, expect, test } from "bun:test";
import type { MainSessionLine } from "../../records/main-session-wire";
import { localKey } from "./local-key";
import { askDesk } from "./mcp-main-session";

// `ask_main_session`'s relay against a made-up desk on a port of its own (never the live door): the key it shows, each
// streamed line reported, the answer returned, presence as JSON, a desk gone or silent answering an error.

const asks: unknown[] = [];
const desk = Bun.serve({
  async fetch(req) {
    if (req.headers.get("authorization") !== `Bearer ${localKey()}`) {
      return new Response("local only", { status: 401 });
    }
    const ask = (await req.json()) as { words?: string };
    asks.push(ask);
    if (!ask.words) {
      return Response.json({ kept: true });
    }
    const lines =
      ask.words === "silent"
        ? [{ kind: "thinking" }]
        : [
            { kind: "thinking" },
            { id: "c1", kind: "working", state: "pending", title: "fetch" },
            { kind: "words", text: "In the drawer." },
            {
              answer: { kind: "reply", words: "In the drawer." },
              kind: "answer",
            },
          ];
    // Split mid-line, as a stream may arrive.
    const text = lines.map((l) => `${JSON.stringify(l)}\n`).join("");
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(text.slice(0, 30)));
          c.enqueue(new TextEncoder().encode(text.slice(30)));
          c.close();
        },
      })
    );
  },
  hostname: "127.0.0.1",
  port: 0,
});
const url = `http://127.0.0.1:${desk.port}/main-session`;
afterAll(() => desk.stop(true));

test("his words go to the desk with his key and screen; each streamed line is reported, and the call ends on the answer", async () => {
  const reported: MainSessionLine[] = [];
  const answer = await askDesk(
    { key: "tap-1", screen: { tab: "inbox" }, words: "Where is my passport?" },
    (l) => reported.push(l),
    url
  );
  expect(answer).toEqual({ kind: "reply", words: "In the drawer." });
  expect(reported.map((l) => l.kind)).toEqual(["thinking", "working", "words"]);
  expect(asks.at(-1)).toEqual({
    key: "tap-1",
    screen: { tab: "inbox" },
    words: "Where is my passport?",
  });
});

test("no words is his presence; a desk that ends with no answer, or is gone, answers an error", async () => {
  expect(await askDesk({}, () => undefined, url)).toEqual({ kept: true });
  expect(await askDesk({ words: "silent" }, () => undefined, url)).toEqual({
    kind: "error",
    what: "Life's desk ended with no answer.",
  });
  const gone = await askDesk(
    { words: "Hello" },
    () => undefined,
    "http://127.0.0.1:9/main-session"
  );
  expect(gone).toMatchObject({ kind: "error" });
  expect((gone as { what: string }).what).toStartWith(
    "Life's desk can't be reached"
  );
});
