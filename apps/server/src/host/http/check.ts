import { join } from "node:path";
import { Hono } from "hono";
import { ROOT } from "../../core/paths";
import { connector } from "../../core/settings";
import { readRatings, readStatements, recordRating } from "../../memory/ledger";
import { plain as asOf } from "../../memory/statements";
import { readPeople } from "../../memory/who";
import { Rating } from "../../schema";
import { HEADERS, redirect, text } from "./http";
import type { SignIn } from "./signin";

// The check page (/check/): he rates the statements (memory/statements.jsonl), each answer appended to ratings.jsonl.
// Behind the owner's sign-in (`signin.ts`); nothing but the sign-in redirects answers before that check.

const ASSETS = join(ROOT, "assets");
const FILES: Record<string, string> = {
  "/check/": "check/index.html",
  "/check/check.css": "check/check.css",
  "/check/check.js": "check/check.js",
  "/check/tokens.css": "brand/tokens.css",
};

const Answer = Rating.pick({ answer: true, claim: true });

/** The check page's routes. */
export function createCheck(signIn: SignIn) {
  const app = new Hono()
    .all("/check/login", () => signIn.login())
    .all("/check/callback", (c) =>
      signIn.callback(c.req.raw, new URL(c.req.url))
    )
    .all("/check", () => redirect("/check/"))
    // Everything past here, for the owner's session only.
    .all("/check/*", async (c, next) => {
      const refused = await signIn.refusal(c.req.raw, c.req.path === "/check/");
      if (refused) {
        return refused;
      }
      await next();
    })
    .get("/check/statements", async () => {
      // By group, the biggest first, each statement with his current answer and the day it was said (`asOf`).
      const [statements, ratings, { names }] = await Promise.all([
        readStatements(),
        readRatings(),
        readPeople(),
      ]);
      const groups = [...Map.groupBy(statements, (s) => s.group)]
        .map(([id, list]) => ({
          id,
          name: id === "events" ? "Events" : (names.get(id) ?? id),
          statements: list.map((s) => ({
            ...s,
            answer: ratings.get(s.claim)?.answer ?? null,
            asOf: asOf(s.date),
          })),
        }))
        .toSorted((a, b) => b.statements.length - a.statements.length);
      return Response.json({ groups }, { headers: HEADERS });
    })
    .post("/check/answer", async (c) => {
      if (c.req.header("origin") !== connector().origin) {
        return text("cross-origin", 400);
      }
      const a = Answer.safeParse(await c.req.json().catch(() => null));
      const known = new Set((await readStatements()).map((s) => s.claim));
      if (!(a.success && known.has(a.data.claim))) {
        return text("no such statement", 400);
      }
      await recordRating(a.data.claim, a.data.answer);
      return new Response(null, { headers: HEADERS, status: 204 });
    });
  for (const [path, file] of Object.entries(FILES)) {
    app.get(
      path,
      () => new Response(Bun.file(join(ASSETS, file)), { headers: HEADERS })
    );
  }
  return app;
}
