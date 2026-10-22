import { expect, test } from "bun:test";
import worker from "./edge";

const env = { MAC_ORIGIN: "http://127.0.0.1:1" };

test("every path goes to the Mac's origin as is, and is a 503 while it is away", async () => {
  const real = globalThis.fetch;
  let seen:
    | { body: string; method: string; redirect?: string; url: string }
    | undefined;
  globalThis.fetch = (async (r: Request, init?: RequestInit) => {
    seen = {
      body: await r.text(),
      method: r.method,
      redirect: init?.redirect,
      url: r.url,
    };
    return new Response("ok");
  }) as typeof fetch;
  try {
    await worker.fetch(
      new Request("https://life.test/mcp?a=1", { body: "{}", method: "POST" }),
      env
    );
  } finally {
    globalThis.fetch = real;
  }
  expect(seen).toEqual({
    body: "{}",
    method: "POST",
    redirect: "manual",
    url: "http://127.0.0.1:1/mcp?a=1",
  });
  // Port 1 refuses at once: the Mac is out of reach.
  const away = await worker.fetch(new Request("https://life.test/"), env);
  expect(away.status).toBe(503);
});
