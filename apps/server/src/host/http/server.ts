import { Hono } from "hono";
import { createRemoteJWKSet } from "jose";
import { DAY } from "../../core/clock";
import { off } from "../../core/outputs";
import { connector } from "../../core/settings";
import { ownerTokens } from "./auth";
import { createCheck } from "./check-page";
import { LOCAL_PORT, PUBLIC_PORT } from "./http";
import { createMcp } from "./mcp";
import { createIssuer } from "./oauth";
import { createPortrait } from "./portrait";
import { createSignIn, keyRefusal } from "./signin";
import { createStatusReads } from "./status-reads";

// The watcher's one HTTP server, on loopback; a tunnel forwards the `connector` setting's origin to it.

/**
 * Serves on loopback, bodies up to 256 KiB: the app's status reads on `LOCAL_PORT`, by its local key, always; and with
 * the `connector` setting, on `PUBLIC_PORT` (where a tunnel forwards its origin) the connector, its issuer, the check
 * page (`check-page.ts`) and the portrait (`portrait.ts`, when LIFE_PORTRAIT_PASSWORD is set). The key is never taken on the
 * public port. 404 for any other path.
 */
export function serve() {
  // The app's port taken (another install's watcher) only leaves the app without its status; the public one never waits on it.
  try {
    listen(LOCAL_PORT, createStatusReads(keyRefusal()).notFound(notFound));
  } catch (e) {
    console.error(
      `Life: 127.0.0.1:${LOCAL_PORT} is off: ${(e as Error).message}`
    );
  }
  const why = off("connector");
  if (why) {
    console.log(`${why}: /mcp, /check and /me are off`);
    return;
  }
  listen(PUBLIC_PORT, signedIn());
}

/** Any path a port's app has no route for (a route that serves nothing, `/me`'s, answers the same). */
const notFound = () => new Response("not found", { status: 404 });

/** One listener on loopback, for `app`'s routes; a port it can't take throws. */
function listen(port: number, app: Hono) {
  Bun.serve({
    // No stack traces or source in an error page: much of this answers before sign-in.
    development: false,
    fetch: app.fetch,
    hostname: "127.0.0.1",
    maxRequestBodySize: 256 * 1024,
    port,
  });
  console.log(`Life: listening on 127.0.0.1:${port}`);
}

/** The connector's parts, behind its sign-in: Life's own issuer or another, /mcp, /check and /me. */
export function signedIn() {
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
        cacheMaxAge: DAY,
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
      ? async (url: string, init: RequestInit) => life.app.request(url, init)
      : fetch
  );
  const app = new Hono();
  if (life) {
    app.route("/", life.app);
  }
  return app
    .route("/", mcp)
    .route("/", createCheck(signIn))
    .route("/", createPortrait())
    .notFound(notFound);
}
