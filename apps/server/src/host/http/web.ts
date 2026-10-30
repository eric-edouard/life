import { join } from "node:path";
import { Hono } from "hono";
import { WEB_DIST } from "../../core/paths";
import { connector } from "../../core/settings";
import {
  decisionId,
  decisionsNow,
  writeDecision,
} from "../../memory/decisions";
import { recordIfFactCheck } from "../../memory/fact-checks";
import { type DecisionRow, OwnerStep } from "../../records/decision";
import { startAgent, wakeOf } from "../events";
import { recipientOf } from "../send";
import { HEADERS, text } from "./http";
import type { SignIn } from "./sign-in";

// The web app (apps/web): its bundle, Life's code and nothing of his, served to anyone; its data under /api/, each
// behind his sign-in. The routes' names live in the app's router only: any GET asking for HTML outside /api/ and
// /.well-known/ gets the app, which routes it (and a signed-out one to /sign-in).

// Vite's `assetsDir`: hashed names, nothing else served from there.
const BUILT = /^\/app\/[\w-]+\.(?:js|css|woff2)$/;
const APP_HEADERS = {
  ...HEADERS,
  "content-security-policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
  "x-robots-tag": "noindex",
};
const OWN = /^\/(?:api|\.well-known)(?:\/|$)/;

/** His decisions as they stand (GET), or his step on one (POST: answered, context, revoked, or asked, his request). */
function decisions(now: () => number) {
  return new Hono()
    .get("/api/decisions", () =>
      Response.json(
        [...decisionsNow().values()].map(
          (d): DecisionRow => ({
            ...d,
            // Only an open card asks his tap: the others need no recipient read.
            to: d.status === "open" ? recipientOf(d.ref) : undefined,
          })
        ),
        { headers: HEADERS }
      )
    )
    .post("/api/decisions", async (c) => {
      if (c.req.header("origin") !== connector().origin) {
        return text("forbidden", 403);
      }
      const step = OwnerStep.safeParse(await c.req.json().catch(() => null));
      if (!step.success) {
        return text("not one of his steps", 400);
      }
      const b = step.data;
      try {
        let asker: string | undefined;
        if (b.step === "asked") {
          // His "Something's wrong": a request (no options) about one loop, for the audit; Life makes its id.
          const { loop, note, ref } = b.data;
          writeDecision(
            [
              {
                data: {
                  context: note,
                  kind: "audit",
                  loop,
                  options: [],
                  question: note.slice(0, 200),
                  ref,
                },
                decision: decisionId(loop, now()),
                step: "asked",
              },
            ],
            now()
          );
        } else {
          const [d] = writeDecision(
            [
              {
                data: "data" in b ? b.data : undefined,
                decision: b.decision,
                step: b.step,
              },
            ],
            now()
          );
          // A fact check is Life's own: his tap is its rating, and no loop is woken.
          asker = d && recordIfFactCheck(d) ? undefined : d?.loop;
        }
        const wake = wakeOf(b.step, asker);
        if (wake) {
          startAgent(wake);
        }
        return text("ok", 200);
      } catch (e) {
        return text((e as Error).message, 409);
      }
    });
}

/** The app's routes; its data only once he is signed in. */
export function createWeb(signIn: SignIn, now = Date.now, dist = WEB_DIST) {
  return new Hono()
    .route("/", signIn.app)
    .use("/api/*", async (c, next) => {
      // The sign-in itself answers before this (it is routed first).
      if (!signIn.signedIn(c.req.raw)) {
        return text("sign in at /sign-in", 401);
      }
      await next();
    })
    .route("/", decisions(now))
    .get("/app/*", async (c) => {
      const file = Bun.file(join(dist, c.req.path));
      return BUILT.test(c.req.path) && (await file.exists())
        ? new Response(file, {
            headers: {
              ...APP_HEADERS,
              "cache-control": "public, max-age=31536000, immutable",
            },
          })
        : c.notFound();
    })
    .get("*", (c, next) =>
      OWN.test(c.req.path) || !c.req.header("accept")?.includes("text/html")
        ? next()
        : new Response(Bun.file(join(dist, "index.html")), {
            headers: {
              ...APP_HEADERS,
              "content-type": "text/html; charset=utf-8",
            },
          })
    );
}
