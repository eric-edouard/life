import { join } from "node:path";
import { Hono } from "hono";
import { off } from "../../core/outputs";
import { LIFE_CODE_DIR } from "../../core/paths";
import { connector } from "../../core/settings";
import { ownerTokens } from "./auth";
import { createCheck } from "./check-page";
import { HEADERS, LOCAL_PORT, PUBLIC_PORT } from "./http";
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

/**
 * Life's brand, nothing of his, open to all at its paths in the repo (so the guide's links work): his agent styles what
 * it makes for him with it, and `/check` links its tokens.
 */
const BRAND = [
  "docs/brand.md",
  "docs/brand/reference.png",
  "assets/brand/tokens.css",
  "assets/brand/life.svg",
  "assets/icon/icon.svg",
];
const brand = new Hono();
for (const file of BRAND) {
  brand.get(
    `/${file}`,
    () =>
      new Response(Bun.file(join(LIFE_CODE_DIR, file)), { headers: HEADERS })
  );
}

/** The connector's parts, behind Life's own sign-in: its issuer, /mcp, /check and /me. */
export function signedIn() {
  const { origin, resource } = connector();
  const life = createIssuer(origin, resource);
  const verify = ownerTokens({
    issuer: life.issuer,
    jwks: life.jwks,
    ownerSub: life.owner,
    resource,
  });
  return new Hono()
    .route("/", life.app)
    .route("/", createMcp(verify, life.issuer))
    .route("/", createCheck(createSignIn(verify, life)))
    .route("/", createPortrait())
    .route("/", brand)
    .notFound(notFound);
}
