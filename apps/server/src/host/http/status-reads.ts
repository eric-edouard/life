import { Hono } from "hono";
import { snapshot } from "../status/snapshot";
import { detail, runDetail } from "../status/snapshot-detail";
import { HEADERS, redirect, serveAssets, text } from "./http";
import type { SignIn } from "./signin";

// The status reads: the status snapshot (`snapshot.ts`), a card's detail and a run (`snapshot-detail.ts`), as JSON:
// for Life.app's native window and menu on the local port, behind its key; and the snapshot alone for the status page
// (`/status/`, the same JSON drawn in a browser) on the public port, behind the owner's sign-in. Read-only: it changes nothing, sends nothing.

const json = (body: unknown) => Response.json(body, { headers: HEADERS });

const CARD = "/status/card/";

/** The reads behind `refusal` (`keyRefusal`: the local key the app holds). */
export function createStatusReads(
  refusal: (req: Request) => Promise<Response | null>
) {
  return (
    new Hono()
      .get("/status/*", async (c, next) => {
        const refused = await refusal(c.req.raw);
        if (refused) {
          return refused;
        }
        await next();
      })
      .get("/status/snapshot", async () => json(await snapshot()))
      // A card's detail, or its next page: `before` must be an instant.
      .get(`${CARD}*`, async (c) => {
        const before = c.req.query("before");
        if (before && Number.isNaN(Date.parse(before))) {
          return text("before must be an instant", 400);
        }
        const id = new URL(c.req.url).pathname.slice(CARD.length);
        return id ? json(await detail(id, before)) : c.notFound();
      })
      .get("/status/run", async (c) => {
        const run = await runDetail(c.req.query("id") ?? "");
        return run ? json(run) : text("no such run", 404);
      })
  );
}

/**
 * The status page (`assets/status/`) and the one read it draws, the status snapshot, behind the owner's sign-in: the
 * page itself sends him to it. A card's detail and the runs stay on the local port, which the page doesn't read.
 */
export function createStatusPage(signIn: SignIn) {
  const app = new Hono()
    .get("/status", () => redirect("/status/"))
    .get("/status/*", signIn.gate("/status/"))
    .get("/status/snapshot", async () => json(await snapshot()));
  return serveAssets(app, {
    "/status/": "status/index.html",
    "/status/status.css": "status/status.css",
    "/status/status.js": "status/status.js",
    "/status/tokens.css": "brand/tokens.css",
  });
}
