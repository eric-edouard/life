import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { off } from "../../core/outputs";
import { LIFE_CODE_DIR } from "../../core/paths";
import { isOwnLife } from "../../core/platform";
import { settings } from "../../core/settings";
import { VOICE_URL } from "../../sources/voice-server-call";
import { ownerTokens } from "./auth";
import { connector, HEADERS, LOCAL_PORT, PUBLIC_PORT } from "./http";
import { keyRefusal } from "./local-key";
import { createMcp } from "./mcp";
import { createIssuer } from "./oauth";
import { createStatusReads } from "./status-reads";
import { forwardToVoice } from "./voice-forward";

// The watcher's one HTTP server, on loopback; a tunnel forwards the `connector` setting's origin to it, and the phone
// link its streams.

/** Life's own bodies; what goes to the voice server is its own to cap. */
const BODY = 256 * 1024;

/**
 * Serves on loopback, bodies up to 256 KiB: the app's status reads on `LOCAL_PORT`, by its local key, always; and
 * unless the connector is off, on `PUBLIC_PORT` (where a tunnel forwards its origin) the
 * connector, its issuer, Life's brand and the voice server's routes (`/voice/*`, its bodies capped by the voice
 * server). The key is never taken on the public port. 404 for any other path.
 */
export function serve() {
  // The app's port taken (another install's watcher) only leaves the app without its status; the public one never waits on it.
  try {
    listen(
      LOCAL_PORT,
      createStatusReads(keyRefusal()).notFound(notFound),
      BODY
    );
  } catch (e) {
    console.error(
      `Life: 127.0.0.1:${LOCAL_PORT} is off: ${(e as Error).message}`
    );
  }
  const why = off("connector");
  if (why) {
    console.log(`${why}: /mcp is off`);
    return;
  }
  // Bun's own cap only: Life's routes keep theirs (`bodyLimit`), and the voice server caps its own.
  listen(PUBLIC_PORT, publicPortRoutes());
}

/** Any path a port's app has no route for. */
const notFound = () => new Response("not found", { status: 404 });

/** One listener on loopback, for `app`'s routes; a port it can't take throws. */
function listen(port: number, app: Hono, maxRequestBodySize?: number) {
  Bun.serve({
    // No stack traces or source in an error page: much of this answers before a token.
    development: false,
    fetch: app.fetch,
    hostname: "127.0.0.1",
    ...(maxRequestBodySize ? { maxRequestBodySize } : {}),
    port,
  });
  console.log(`Life: listening on 127.0.0.1:${port}`);
}

/**
 * Life's brand, nothing of his, open to all at its paths in the repo (so the guide's links work): his agent styles what
 * it makes for him with it.
 */
const BRAND = [
  "docs/brand.md",
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

/**
 * Where `/voice` forwards: the `lifelog` setting, else voice's own address on his own Life alone (a demo Life never
 * fronts his voice); none, no `/voice`.
 */
export const voiceAddressOf = ({
  own,
  set,
}: {
  own: boolean;
  set: string | undefined;
}) => set ?? (own ? VOICE_URL : undefined);

/**
 * The connector's parts: its issuer, /mcp (behind Life's own tokens) and Life's brand, bodies up to 256 KiB; and the
 * voice server's routes under `/voice` (`voiceAddressOf`).
 */
export function publicPortRoutes(
  voice = voiceAddressOf({ own: isOwnLife(), set: settings().lifelog?.url })
) {
  const { origin, resource } = connector();
  const life = createIssuer(origin, resource);
  const verify = ownerTokens({
    issuer: life.issuer,
    jwks: life.jwks,
    ownerSub: life.owner,
    resource,
  });
  const app = new Hono();
  if (voice) {
    app.all("/voice/*", forwardToVoice(voice));
  }
  return app
    .use(bodyLimit({ maxSize: BODY }))
    .route("/", life.app)
    .route("/", createMcp(verify, life.issuer))
    .route("/", brand)
    .notFound(notFound);
}
