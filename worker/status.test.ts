import { expect, test } from "bun:test";
import worker from "./status";

// The Worker answers for the Mac only to the owner, and takes a push only with the Mac's secret.
const kv = {
  getWithMetadata: () => Promise.resolve({ metadata: null, value: "x" }),
  put: () => Promise.reject(new Error("nothing may be written")),
};
const env = (secret: string) =>
  ({
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
    expect(await res.text()).not.toContain("x");
  }
});
