import { createRemoteJWKSet } from "jose";
import { ownerTokens } from "./auth";
import { createCheck } from "./check";
import { createDashboard, pushPlate, warmPage } from "./dashboard";
import { createMcp } from "./mcp";
import { createPortrait } from "./portrait";
import { connector, settings } from "./settings";
import { createSignIn } from "./signin";

// The watcher's one HTTP server, on loopback; a tunnel forwards the `connector` setting's origin to it.

/** Serves the connector, the check page (`check.ts`), the status page (`dashboard.ts`) and the portrait (`portrait.ts`, when LIFE_PORTRAIT_PASSWORD is set) on loopback (127.0.0.1:46200, bodies up to 256 KiB), 404 for any other path; off, with a line saying so, when the connector is not set up. */
export function serveConnector() {
  if (!settings().connector) {
    console.log(
      "Connector: not set up (settings: connector), /mcp, /check, /me and the status page are off"
    );
    return;
  }
  const { issuer, owner, resource } = connector();
  const verify = ownerTokens({
    issuer,
    // lifelog's keys rarely change: kept a day (a key it dropped stops working within it), or refetched sooner when a
    // token names a key they lack, so its latency reaches about one request a day; a failed fetch answers 503 (jose
    // serves no stale keys, so lifelog down when the day ends is a 503 until it is back).
    jwks: createRemoteJWKSet(new URL(`${issuer}/jwks`), {
      cacheMaxAge: 24 * 3600 * 1000,
      timeoutDuration: 15_000,
    }),
    ownerSub: owner,
    resource,
  });
  const mcp = createMcp(verify);
  const signIn = createSignIn(verify);
  const check = createCheck(signIn);
  const dashboard = createDashboard(signIn);
  const portrait = createPortrait();
  Bun.serve({
    // No stack traces or source in an error page: much of this answers before sign-in.
    development: false,
    fetch: async (req) =>
      (await mcp.handle(req)) ??
      (await check.handle(req)) ??
      (await portrait.handle(req)) ??
      (await dashboard.handle(req)) ??
      new Response("not found", { status: 404 }),
    hostname: "127.0.0.1",
    maxRequestBodySize: 256 * 1024,
    port: 46_200,
  });
  console.log("Connector: listening on 127.0.0.1:46200");
  warmPage();
  pushPlate();
}
