import { join } from "node:path";
import { ORIGIN } from "./auth";
import { HEADERS, redirect, text } from "./http";
import { readRatings, readStatements, recordRating } from "./memory/ledger";
import { plain as asOf } from "./memory/statements";
import { readPeople } from "./memory/who";
import { Rating } from "./schema";
import type { SignIn } from "./signin";
import { ROOT } from "./truth";

// The check page (/check/): he rates the statements (memory/statements.jsonl), each answer appended to ratings.jsonl.
// Behind the owner's sign-in (`signin.ts`); nothing but the sign-in redirects answers before that check.

const ASSETS = join(ROOT, "assets", "check");
const FILES: Record<string, string> = {
  "/check/": "index.html",
  "/check/check.css": "check.css",
  "/check/check.js": "check.js",
};

const Answer = Rating.pick({ answer: true, claim: true });

/** The check page's routes; `handle` resolves to null for any other path. */
export function createCheck(signIn: SignIn) {
  /** Everything past sign-in, for the owner's session only. */
  async function owned(req: Request, pathname: string) {
    const file = FILES[pathname];
    if (file) {
      return new Response(Bun.file(join(ASSETS, file)), { headers: HEADERS });
    }
    if (pathname === "/check/statements" && req.method === "GET") {
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
    }
    if (pathname === "/check/answer" && req.method === "POST") {
      if (req.headers.get("origin") !== ORIGIN) {
        return text("cross-origin", 400);
      }
      const a = Answer.safeParse(await req.json().catch(() => null));
      const known = new Set((await readStatements()).map((s) => s.claim));
      if (!(a.success && known.has(a.data.claim))) {
        return text("no such statement", 400);
      }
      await recordRating(a.data.claim, a.data.answer);
      return new Response(null, { headers: HEADERS, status: 204 });
    }
    return null;
  }

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const { pathname } = url;
    if (pathname === "/check/login") {
      return signIn.login(url.searchParams.get("next") ?? "/check/");
    }
    if (pathname === "/check/callback") {
      return signIn.callback(req, url);
    }
    if (pathname === "/check") {
      return redirect("/check/");
    }
    if (!pathname.startsWith("/check/")) {
      return null;
    }
    const refused = await signIn.refusal(
      req,
      pathname === "/check/" ? "/check/" : undefined
    );
    if (refused) {
      return refused;
    }
    return owned(req, pathname);
  }

  return { handle };
}
