import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  CHECK_CLIENT,
  ISSUER,
  ORIGIN,
  RESOURCE,
  SCOPE,
  type Verify,
} from "./auth";
import { readRatings, readStatements, recordRating } from "./memory/ledger";
import { readPeople } from "./memory/who";
import { Rating } from "./schema";
import { ROOT } from "./truth";

// The check page (/check/): he rates the statements (memory/statements.jsonl), each answer appended to ratings.jsonl.
// Sign-in is lifelog's OAuth with PKCE; the token lives in an HttpOnly cookie, checked on every request by
// `ownerTokens` like /mcp's Bearer token. Nothing but the sign-in redirects answers before that check.

const CALLBACK = `${ORIGIN}/check/callback`;
const SESSION = "__Host-life";
const LOGIN = "__Host-life-login";
const ASSETS = join(ROOT, "assets", "check");
const FILES: Record<string, string> = {
  "/check/": "index.html",
  "/check/check.css": "check.css",
  "/check/check.js": "check.js",
};
const HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const LOGIN_MAX_S = 600;

const Answer = Rating.pick({ answer: true, claim: true });

const cookie = (name: string, value: string, maxAge: number) =>
  new Bun.Cookie(name, value, {
    httpOnly: true,
    maxAge,
    path: "/",
    sameSite: "lax",
    secure: true,
  }).serialize();

const redirect = (to: string, cookies: string[] = []) => {
  const headers = new Headers({ ...HEADERS, location: to });
  for (const c of cookies) {
    headers.append("set-cookie", c);
  }
  return new Response(null, { headers, status: 302 });
};

const cookieOf = (req: Request, name: string) =>
  new Bun.CookieMap(req.headers.get("cookie") ?? "").get(name);

const plain = (body: string, status: number) =>
  new Response(body, { headers: HEADERS, status });

/** The check page's routes; `handle` resolves to null for any other path. `lifelog` reaches its token endpoint. */
export function createCheck(verify: Verify, lifelog: typeof fetch = fetch) {
  /** Off to lifelog's sign-in (silent once he is signed in there and consented), with PKCE. */
  function login() {
    const state = randomBytes(16).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const url = new URL(`${ISSUER}/oauth2/authorize`);
    url.search = new URLSearchParams({
      client_id: CHECK_CLIENT,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      redirect_uri: CALLBACK,
      resource: RESOURCE,
      response_type: "code",
      scope: SCOPE,
      state,
    }).toString();
    return redirect(url.toString(), [
      cookie(LOGIN, `${state}.${verifier}`, LOGIN_MAX_S),
    ]);
  }

  /** Back from lifelog: the code is traded for a token, which must be the owner's before it becomes the session. */
  async function callback(req: Request, url: URL) {
    const [state, verifier] = (cookieOf(req, LOGIN) ?? "").split(".");
    const code = url.searchParams.get("code");
    if (
      !(state && verifier && code) ||
      url.searchParams.get("state") !== state
    ) {
      return plain("Sign-in did not complete. Open /check/ to try again.", 400);
    }
    const res = await lifelog(`${ISSUER}/oauth2/token`, {
      body: new URLSearchParams({
        client_id: CHECK_CLIENT,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: CALLBACK,
        resource: RESOURCE,
      }),
      method: "POST",
    });
    const token = z
      .object({ access_token: z.string(), expires_in: z.number() })
      .safeParse(res.ok ? await res.json() : null);
    if (
      !token.success ||
      typeof (await verify(token.data.access_token)) !== "object"
    ) {
      return plain("Not signed in as the owner.", 403);
    }
    return redirect("/check/", [
      cookie(SESSION, token.data.access_token, token.data.expires_in),
      cookie(LOGIN, "", 0),
    ]);
  }

  /** Everything past sign-in, for the owner's session only. */
  async function owned(req: Request, pathname: string) {
    const file = FILES[pathname];
    if (file) {
      return new Response(Bun.file(join(ASSETS, file)), { headers: HEADERS });
    }
    if (pathname === "/check/statements" && req.method === "GET") {
      // By group, the biggest first, each statement with his current answer.
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
          })),
        }))
        .toSorted((a, b) => b.statements.length - a.statements.length);
      return Response.json({ groups }, { headers: HEADERS });
    }
    if (pathname === "/check/answer" && req.method === "POST") {
      if (req.headers.get("origin") !== ORIGIN) {
        return plain("cross-origin", 400);
      }
      const a = Answer.safeParse(await req.json().catch(() => null));
      const known = new Set((await readStatements()).map((s) => s.claim));
      if (!(a.success && known.has(a.data.claim))) {
        return plain("no such statement", 400);
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
      return login();
    }
    if (pathname === "/check/callback") {
      return callback(req, url);
    }
    if (pathname === "/check") {
      return redirect("/check/");
    }
    if (!pathname.startsWith("/check/")) {
      return null;
    }
    const whose = await verify(cookieOf(req, SESSION) ?? "");
    if (typeof whose !== "object") {
      if (whose.startsWith("forbidden")) {
        return plain("forbidden", 403);
      }
      return pathname === "/check/" ? login() : plain("sign in again", 401);
    }
    return owned(req, pathname);
  }

  return { handle };
}
