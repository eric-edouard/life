import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  CHECK_CLIENT,
  ISSUER,
  ORIGIN,
  RESOURCE,
  SCOPE,
  UNREACHABLE,
  type Verify,
} from "./auth";
import { cookie, cookieOf, redirect, text } from "./http";

// The owner's sign-in for Life's pages (/check/, the status page at /): lifelog's OAuth with PKCE, the token in an
// HttpOnly cookie for the whole site, checked on every request by `ownerTokens` like /mcp's Bearer token. The
// callback stays /check/callback, the one redirect lifelog knows for this client.

const CALLBACK = `${ORIGIN}/check/callback`;
const SESSION = "__Host-life";
const LOGIN = "__Host-life-login";
const LOGIN_MAX_S = 600;
/** Where a sign-in may land: the pages behind it. */
const PAGES = new Set(["/", "/check/"]);

export function createSignIn(verify: Verify, lifelog: typeof fetch = fetch) {
  /** Off to lifelog's sign-in (silent once he is signed in there and consented), with PKCE; back to `next` after. */
  function login(next = "/check/") {
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
    const page = PAGES.has(next) ? next : "/check/";
    return redirect(url.toString(), [
      cookie(LOGIN, `${state}.${verifier}.${page}`, LOGIN_MAX_S),
    ]);
  }

  /** Back from lifelog: the code is traded for a token, which must be the owner's before it becomes the session. */
  async function callback(req: Request, url: URL) {
    const [state, verifier, next] = (cookieOf(req, LOGIN) ?? "").split(".");
    const code = url.searchParams.get("code");
    if (
      !(state && verifier && code) ||
      url.searchParams.get("state") !== state
    ) {
      return text(
        "Sign-in did not complete. Open the page again to retry.",
        400
      );
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
    if (!token.success) {
      return text("Not signed in as the owner.", 403);
    }
    const whose = await verify(token.data.access_token);
    if ("refusal" in whose) {
      return whose.refusal === "unreachable"
        ? text(UNREACHABLE, 503)
        : text("Not signed in as the owner.", 403);
    }
    return redirect(next && PAGES.has(next) ? next : "/check/", [
      cookie(SESSION, token.data.access_token, token.data.expires_in),
      cookie(LOGIN, "", 0),
    ]);
  }

  /**
   * Null when the request carries the owner's session; else the answer: a sign-in for a page (`page`), 401 for its
   * reads, 403 for someone else, 503 when lifelog's keys are out of reach.
   */
  async function refusal(req: Request, page?: string) {
    const whose = await verify(cookieOf(req, SESSION) ?? "");
    if (!("refusal" in whose)) {
      return null;
    }
    if (whose.refusal === "forbidden") {
      return text("forbidden", 403);
    }
    if (whose.refusal === "unreachable") {
      return text(UNREACHABLE, 503);
    }
    return page ? login(page) : text("sign in again", 401);
  }

  return { callback, login, refusal };
}

export type SignIn = ReturnType<typeof createSignIn>;
