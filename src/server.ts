import { createRemoteJWKSet } from "jose";
import { ownerTokens } from "./auth";
import { createCheck } from "./check";
import { createDashboard, pushPlate, warmPage } from "./dashboard";
import { LOCAL_PORT, PUBLIC_PORT } from "./http";
import { createMcp } from "./mcp";
import { createIssuer } from "./oauth";
import { createPortrait } from "./portrait";
import { connector, settings } from "./settings";
import { createSignIn, keyRefusal } from "./signin";

// The watcher's one HTTP server, on loopback; a tunnel forwards the `connector` setting's origin to it.

/**
 * Serves on loopback, bodies up to 256 KiB: the status page for the app on `LOCAL_PORT`, by its local key, always; and
 * with the `connector` setting, on `PUBLIC_PORT` (where a tunnel forwards its origin) the connector, its issuer, the
 * check page (`check.ts`), the portrait (`portrait.ts`, when LIFE_PORTRAIT_PASSWORD is set) and the status page behind
 * his sign-in. The key is never taken on the public port. 404 for any other path.
 */
export function serve() {
  warmPage();
  // The app's port taken (another install's watcher) only leaves the app without its page; the public one never waits on it.
  try {
    listen(LOCAL_PORT, createDashboard(keyRefusal()).handle);
  } catch (e) {
    console.error(
      `Life: 127.0.0.1:${LOCAL_PORT} is off: ${(e as Error).message}`
    );
  }
  if (!settings().connector) {
    console.log(
      "Connector: not set up (settings: connector): /mcp, /check, /me and the public status page are off"
    );
    return;
  }
  const signed = signedIn();
  const page = createDashboard(signed.signIn.refusal);
  listen(
    PUBLIC_PORT,
    async (req) => (await signed.handle(req)) ?? (await page.handle(req))
  );
  pushPlate();
}

/** One listener on loopback; a port it can't take throws. */
function listen(
  port: number,
  handle: (req: Request) => Promise<Response | null>
) {
  Bun.serve({
    // No stack traces or source in an error page: much of this answers before sign-in.
    development: false,
    fetch: async (req) =>
      (await handle(req)) ?? new Response("not found", { status: 404 }),
    hostname: "127.0.0.1",
    maxRequestBodySize: 256 * 1024,
    port,
  });
  console.log(`Life: listening on 127.0.0.1:${port}`);
}

/** The connector's parts, behind its sign-in: Life's own issuer or another, /mcp, /check and /me. */
function signedIn() {
  const { issuer, origin, own, owner, resource } = connector();
  const life = own ? createIssuer(origin, resource) : null;
  const verify = ownerTokens({
    issuer,
    // lifelog's keys rarely change: kept a day (a key it dropped stops working within it), or refetched sooner when a
    // token names a key they lack, so its latency reaches about one request a day; a failed fetch answers 503 (jose
    // serves no stale keys, so lifelog down when the day ends is a 503 until it is back).
    jwks:
      life?.jwks ??
      createRemoteJWKSet(new URL(`${issuer}/jwks`), {
        cacheMaxAge: 24 * 3600 * 1000,
        timeoutDuration: 15_000,
      }),
    ownerSub: owner,
    resource,
  });
  const mcp = createMcp(verify);
  // Life's own issuer answers its pages' token exchange in this process.
  const signIn = createSignIn(
    verify,
    life
      ? async (url: string, init: RequestInit) =>
          (await life.handle(new Request(url, init))) ??
          new Response(null, { status: 404 })
      : fetch
  );
  const check = createCheck(signIn);
  const portrait = createPortrait();
  return {
    handle: async (req: Request) =>
      (await life?.handle(req)) ??
      (await mcp.handle(req)) ??
      (await check.handle(req)) ??
      (await portrait.handle(req)),
    signIn,
  };
}
