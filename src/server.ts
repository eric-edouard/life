import { createRemoteJWKSet } from "jose";
import { ISSUER, ownerTokens } from "./auth";
import { createCheck } from "./check";
import { createMcp } from "./mcp";
import { createPortrait } from "./portrait";

// The watcher's one HTTP server, on loopback; the Cloudflare tunnel forwards life.ericedouard.com to it.

/** Serves the connector, the check page (`check.ts`) and the portrait (`portrait.ts`, when LIFE_PORTRAIT_PASSWORD is set) on loopback (127.0.0.1:46200, bodies up to 256 KiB), 404 for any other path; off, with a line saying so, when LIFE_OWNER_SUB is not set. */
export function serveConnector() {
  const ownerSub = process.env.LIFE_OWNER_SUB;
  if (!ownerSub) {
    console.log(
      "Connector: LIFE_OWNER_SUB is not set, /mcp, /check and /me are off"
    );
    return;
  }
  const verify = ownerTokens({
    // lifelog's keys rarely change: kept a day (a key it dropped stops working within it), or refetched sooner when a
    // token names a key they lack, so its latency reaches about one request a day; a failed fetch answers 503 (jose
    // serves no stale keys, so lifelog down when the day ends is a 503 until it is back).
    jwks: createRemoteJWKSet(new URL(`${ISSUER}/jwks`), {
      cacheMaxAge: 24 * 3600 * 1000,
      timeoutDuration: 15_000,
    }),
    ownerSub,
  });
  const mcp = createMcp(verify);
  const check = createCheck(verify);
  const portrait = createPortrait();
  Bun.serve({
    // No stack traces or source in an error page: much of this answers before sign-in.
    development: false,
    fetch: async (req) =>
      (await mcp.handle(req)) ??
      (await check.handle(req)) ??
      (await portrait.handle(req)) ??
      new Response("not found", { status: 404 }),
    hostname: "127.0.0.1",
    maxRequestBodySize: 256 * 1024,
    port: 46_200,
  });
  console.log("Connector: listening on 127.0.0.1:46200");
}
