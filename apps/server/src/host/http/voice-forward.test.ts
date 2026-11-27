import { afterAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { publicPortRoutes } from "./server";

// A made-up voice server: echoes what reached it, a gzipped answer, a long wait, and its map page.
const seen: { path: string; auth: string | null; sha: string }[] = [];
const voice = Bun.serve({
  async fetch(req) {
    const { pathname, search } = new URL(req.url);
    const body = new Uint8Array(await req.arrayBuffer());
    seen.push({
      auth: req.headers.get("authorization"),
      path: `${pathname}${search}`,
      sha: createHash("sha256").update(body).digest("hex"),
    });
    if (pathname === "/gzip") {
      return new Response(gzipSync("made-up words"), {
        headers: { "content-encoding": "gzip" },
      });
    }
    if (pathname === "/changes") {
      await Bun.sleep(4000);
    }
    return new Response("ok");
  },
  hostname: "127.0.0.1",
  idleTimeout: 60,
  maxRequestBodySize: 65 * 1024 * 1024,
  port: 0,
});
const lifeAt = (voiceAt: string) =>
  Bun.serve({
    development: false,
    fetch: publicPortRoutes(voiceAt).fetch,
    hostname: "127.0.0.1",
    // Life's listener as it serves, but an idle limit of 1 s, so the long poll's test is quick.
    idleTimeout: 1,
    port: 0,
  });
const life = lifeAt(`http://127.0.0.1:${voice.port}`);
const at = (path: string) => `http://127.0.0.1:${life.port}${path}`;
afterAll(() => {
  life.stop(true);
  voice.stop(true);
});

test("/voice/… reaches the voice server without its prefix, with its query and token, its body whole", async () => {
  const body = randomBytes(20 * 1024 * 1024);
  const res = await fetch(at("/voice/backup/pack?since=5"), {
    body,
    headers: { authorization: "Bearer made-up" },
    method: "PUT",
  });
  expect(res.status).toBe(200);
  expect(seen.at(-1)).toEqual({
    auth: "Bearer made-up",
    path: "/backup/pack?since=5",
    sha: createHash("sha256").update(body).digest("hex"),
  });
});

test("Life's own routes still refuse a body over 256 KiB; only /voice takes more", async () => {
  const res = await fetch(at("/mcp"), {
    body: randomBytes(300 * 1024),
    method: "POST",
  });
  expect(res.status).toBe(413);
});

test("the voice server's answer passes as it came, gzip included", async () => {
  const res = await fetch(at("/voice/gzip"), { decompress: false });
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(
    new Uint8Array(gzipSync("made-up words"))
  );
});

test("a long poll outlasts the listener's idle limit", async () => {
  // Bun checks idle limits every few seconds: 4 s is past a 1 s limit for sure.
  expect((await fetch(at("/voice/changes?wait=4"))).status).toBe(200);
}, 10_000);

test("the speaker map stays off Life's origin, a look-alike path is not the voice server's, and its absence is a 502", async () => {
  expect((await fetch(at("/voice/voices"))).status).toBe(404);
  expect((await fetch(at("/voice/voices/x.js"))).status).toBe(404);
  expect((await fetch(at("/voice/%76oices"))).status).toBe(404);
  expect((await fetch(at("/voicex/health"))).status).toBe(404);
  const off = lifeAt("http://127.0.0.1:1");
  expect(
    (await fetch(`http://127.0.0.1:${off.port}/voice/health`)).status
  ).toBe(502);
  off.stop(true);
});

test("with no voice server set, Life has no /voice", async () => {
  const res = await publicPortRoutes("").request("/voice/health");
  expect(res.status).toBe(404);
});
