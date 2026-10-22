import { createRemoteJWKSet } from "jose";
import { ownerTokens } from "./auth";
import { createCheck } from "./check";
import { createDashboard, pushPlate, warmPage } from "./dashboard";
import { createMcp } from "./mcp";
import { createIssuer } from "./oauth";
import { createPortrait } from "./portrait";
import { connector, settings } from "./settings";
import { createSignIn } from "./signin";

// The watcher's one HTTP server, on loopback; a tunnel forwards the `connector` setting's origin to it.

/**
 * Serves on loopback (127.0.0.1:46200, bodies up to 256 KiB): the status page always (`dashboard.ts`: his sign-in, or
 * the local key the app holds), and with the `connector` setting the connector, its issuer, the check page
 * (`check.ts`) and the portrait (`portrait.ts`, when LIFE_PORTRAIT_PASSWORD is set); 404 for any other path.
 */
export function serve() {
  const signed = settings().connector ? signedIn() : null;
  if (!signed) {
    console.log(
      "Connector: not set up (settings: connector): /mcp, /check and /me are off, the status page is local only"
    );
  }
  const dashboard = createDashboard(signed?.signIn ?? null);
  Bun.serve({
    // No stack traces or source in an error page: much of this answers before sign-in.
    development: false,
    fetch: async (req) =>
      (await signed?.handle(req)) ??
      (await dashboard.handle(req)) ??
      new Response("not found", { status: 404 }),
    hostname: "127.0.0.1",
    maxRequestBodySize: 256 * 1024,
    port: 46_200,
  });
  console.log("Life: listening on 127.0.0.1:46200");
  warmPage();
  if (signed) {
    pushPlate();
  }
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
