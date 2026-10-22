import { expect, test } from "bun:test";
import worker from "./status";

// The Worker answers for the Mac only to the owner, and takes a push only with the Mac's secret.
const kv = {
  getWithMetadata: () => Promise.resolve({ metadata: null, value: "x" }),
  put: () => Promise.reject(new Error("nothing may be written")),
};
const env = (secret: string) =>
  ({
    MAC_ORIGIN: "http://127.0.0.1:1",
    OWNER_SUB: "owner",
    PUSH_SECRET: secret,
    STATUS: kv,
  }) as unknown as Parameters<typeof worker.fetch>[1];

test("a push without the secret, or with none set, writes nothing", async () => {
  const push = (auth: string, secret: string) =>
    worker.fetch(
      new Request("http://127.0.0.1:1/__status/push", {
        body: "{}",
        headers: { authorization: auth },
        method: "POST",
      }),
      env(secret)
    );
  expect((await push("Bearer x", "")).status).toBe(401);
  expect((await push("Bearer undefined", "")).status).toBe(401);
  expect((await push("Bearer short", "a-much-longer-secret")).status).toBe(401);
});

test("with the Mac away, someone who isn't the owner gets nothing of his", async () => {
  // Port 1 refuses at once: the Mac is out of reach.
  for (const path of ["/", "/status/snapshot", "/status/app.js"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one at a time is enough here
    const res = await worker.fetch(
      new Request(`http://127.0.0.1:1${path}`),
      env("s")
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(
      "Life's Mac is offline. Sign in once it is back."
    );
  }
});

test("every other path goes to the Mac's origin as is, and is a 503 while it is away", async () => {
  const real = globalThis.fetch;
  let seen: { redirect?: string; url: string } | undefined;
  globalThis.fetch = ((r: Request, init?: RequestInit) => {
    seen = { redirect: init?.redirect, url: r.url };
    return Promise.resolve(new Response("ok"));
  }) as typeof fetch;
  try {
    await worker.fetch(new Request("https://life.test/mcp?a=1"), env("s"));
  } finally {
    globalThis.fetch = real;
  }
  expect(seen).toEqual({
    redirect: "manual",
    url: "http://127.0.0.1:1/mcp?a=1",
  });
  const away = await worker.fetch(
    new Request("https://life.test/mcp"),
    env("s")
  );
  expect(away.status).toBe(503);
});
