// The server: auth, error handling and Life's OAuth, around each domain's routes (routes/).
import { timingSafeEqual } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  asNativeIfLoopback,
  consentPage,
  redirectHost,
  signInPage,
} from "@life/voice-auth";
import { authOauthClient } from "@life/voice-db/schema/auth";
import { eq } from "drizzle-orm";
import { bearerAuth } from "hono/bearer-auth";
import { except } from "hono/combine";
import { HTTPException } from "hono/http-exception";
import { type Config, logged, sha256Hex } from "./config";
import { storeServerError } from "./diagnostics";
import { backupRoutes } from "./routes/backup";
import { conversationRoutes } from "./routes/conversations";
import { healthRoutes } from "./routes/health";
import { pageRoutes } from "./routes/pages";
import { placeRoutes } from "./routes/places";
import { quickRoutes } from "./routes/quick";
import { searchRoutes } from "./routes/search";
import { speakerRoutes } from "./routes/speakers";
import { speechRoutes } from "./routes/speech";
import { switchRoutes } from "./routes/switches";
import { MAC_SOCKET_PATH, syncRoutes } from "./routes/sync";
import { timelineRoutes } from "./routes/timeline";
import { transcriptionRoutes } from "./routes/transcription";
import type { Services } from "./services";

// Life's OAuth (@life/voice-auth) answers for itself; its tokens are for Life and open nothing here.
const PUBLIC_PATHS = [
  "/health",
  "/webhooks/elevenlabs",
  "/api/auth/*",
  "/.well-known/*",
  "/consent",
  "/sign-in",
];
// What a reader's token opens (docs/voice/voice-source.md); the device token opens every route.
const READS = [
  "GET /capabilities",
  "GET /changes",
  "GET /conversations/{id}",
  "GET /status",
  "GET /transcription-jobs/{id}/transcript",
  "GET /visits",
  "GET /where",
  "POST /search",
];
const CORRECTIONS = [
  ...READS,
  "PATCH /people/{id}",
  "POST /people/{id}/merge",
  "PUT /conversations/{id}/title",
  "PUT /transcripts/{jobId}/speakers/{speakerLabel}",
];
const opening = (routes: string[]) => {
  const patterns = routes.map(
    (r) => new RegExp(`^${r.replaceAll(/\{[^}]+\}/g, "[^/]+")}$`)
  );
  return (method: string, path: string) =>
    patterns.some((p) => p.test(`${method} ${path}`));
};
// Writes that change nothing searchable: no search sweep after them.
const UNSEARCHED = new Set([
  "/search",
  "/health/heartbeat",
  "/events",
  "/diagnostics",
  "/quick-transcriptions",
  // It sweeps itself when AI comes back on.
  "/switches",
]);

export function createApp(s: Services) {
  const { auth, config, db, search } = s;
  // Each token's hash, and the routes it opens (null: all).
  const tokens = [
    [config.DEVICE_TOKEN_HASH, null],
    [config.READ_TOKEN_HASH, opening(READS)],
    [config.CORRECTIONS_TOKEN_HASH, opening(CORRECTIONS)],
  ] as const;
  const app = new OpenAPIHono();
  // A route that throws: logged, kept as a `server_error` diagnostic (never the request body),
  // and answered in the routes' error shape. Hono's own refusals (401, malformed JSON) pass.
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return error.getResponse();
    }
    // The client hung up mid-request (a pass cut short, the network gone): nothing failed here.
    if (c.req.raw.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    console.error(`${c.req.method} ${c.req.path}:`, error);
    logged("server error not stored", () =>
      storeServerError(db, error, {
        appBuild: config.BUILD_SHA?.slice(0, 7) ?? "dev",
        method: c.req.method,
        route: c.req.routePath,
      })
    );
    return c.json(
      {
        error: "internal_error" as const,
        message: "The server failed; it was reported.",
      },
      500
    );
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
    scheme: "bearer",
    type: "http",
  });
  app.use(
    "*",
    except(
      [...PUBLIC_PATHS, MAC_SOCKET_PATH],
      bearerAuth({
        verifyToken: (token, c) => {
          const hash = Buffer.from(sha256Hex(token), "hex");
          const found = tokens.find(
            ([known]) =>
              known !== undefined &&
              timingSafeEqual(hash, Buffer.from(known, "hex"))
          );
          if (found?.[1] && !found[1](c.req.method, c.req.path)) {
            throw new HTTPException(403, {
              message: "This token doesn't open this route.",
            });
          }
          return found !== undefined;
        },
      })
    )
  );
  // The Mac's token opens its socket and nothing else; the device token doesn't open it.
  const macHash = config.MAC_TOKEN_HASH
    ? Buffer.from(config.MAC_TOKEN_HASH, "hex")
    : null;
  const macAuth = bearerAuth({
    verifyToken: (token) =>
      macHash !== null &&
      timingSafeEqual(Buffer.from(sha256Hex(token), "hex"), macHash),
  });
  app.use(MAC_SOCKET_PATH, macAuth);
  if (auth) {
    app.post("/api/auth/oauth2/register", async (c) =>
      auth.handler(await asNativeIfLoopback(c.req.raw))
    );
    app.on(["GET", "POST"], ["/api/auth/*", "/.well-known/*"], (c) =>
      auth.handler(c.req.raw)
    );
    app.get("/sign-in", (c) => c.html(signInPage()));
    app.get("/consent", (c) => {
      const client = db
        .select({ name: authOauthClient.name })
        .from(authOauthClient)
        .where(eq(authOauthClient.clientId, c.req.query("client_id") ?? ""))
        .get();
      return c.html(
        consentPage(
          client?.name ?? "An assistant",
          redirectHost(c.req.query("redirect_uri") ?? "")
        )
      );
    });
  }
  // Whatever a write changed (a transcript, the time map, a speaker, a person's name),
  // the search index catches up in the background. A sweep reads only what is stale.
  app.use("*", async (c, next) => {
    await next();
    if (
      search &&
      c.req.method !== "GET" &&
      !UNSEARCHED.has(c.req.path) &&
      c.res.ok
    ) {
      search.index();
    }
  });

  app
    .route("/", healthRoutes(s))
    .route("/", transcriptionRoutes(s))
    .route("/", speechRoutes(s))
    .route("/", pageRoutes(s))
    .route("/", quickRoutes(s))
    .route("/", backupRoutes(s))
    .route("/", speakerRoutes(s))
    .route("/", syncRoutes(s))
    .route("/", conversationRoutes(s))
    .route("/", placeRoutes(s))
    .route("/", searchRoutes(s))
    .route("/", switchRoutes(s))
    .route("/", timelineRoutes(s));
  app.get("/openapi.json", (c) => c.json(openApiDocument(app, config)));
  return app;
}

export const openApiDocument = (app: OpenAPIHono, config: Config) =>
  app.getOpenAPI31Document({
    info: { title: "Life voice server", version: "1" },
    openapi: "3.1.0",
    security: [{ Bearer: [] }],
    servers: [{ url: config.PUBLIC_BASE_URL }],
  });
