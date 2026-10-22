import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { same, secretIn } from "../../core/secret";
import { connector } from "../../core/settings";
import { SCOPE, UNREACHABLE, type Verify } from "./auth";
import { cookie, cookieOf, redirect, SESSION, text } from "./http";

// The owner's sign-in for /check/: the connector's OAuth server with PKCE, the
// token in an HttpOnly cookie for the whole site, checked on every request by `ownerTokens` like /mcp's Bearer token.
// The callback stays /check/callback, the one redirect the issuer knows for this client.

const LOGIN = "__Host-life-login";
const LOGIN_MAX_S = 600;
/** The issuer's refresh token, when it gives one: the session is renewed with it, no sign-in again each hour. */
const REFRESH = "__Host-life-refresh";
const REFRESH_MAX_S = 90 * 86_400;
const Tokens = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
});
/** The cookies a token response becomes: the session, and its refresh token when there is one. */
const sessionCookies = (t: z.infer<typeof Tokens>) => [
  cookie(SESSION, t.access_token, t.expires_in),
  ...(t.refresh_token ? [cookie(REFRESH, t.refresh_token, REFRESH_MAX_S)] : []),
];

/** How the token exchange reaches the issuer: `fetch`, or the issuer itself when it is Life's own (server.ts). */
export type Exchange = (url: string, init: RequestInit) => Promise<Response>;

export function createSignIn(verify: Verify, lifelog: Exchange = fetch) {
  const { client, issuer, origin, resource } = connector();
  const CALLBACK = `${origin}/check/callback`;
  /** Off to lifelog's sign-in (silent once he is signed in there and consented), with PKCE; back to /check/ after. */
  function login() {
    const state = randomBytes(16).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const url = new URL(`${issuer}/oauth2/authorize`);
    url.search = new URLSearchParams({
      client_id: client,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      redirect_uri: CALLBACK,
      resource,
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
      return text(
        "Sign-in did not complete. Open the page again to retry.",
        400
      );
    }
    const token = await trade({
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: CALLBACK,
      resource,
    });
    if (token === "unreachable") {
      return text(UNREACHABLE, 503);
    }
    if (token === "refused") {
      return text("Not signed in as the owner.", 403);
    }
    return redirect("/check/", [
      ...sessionCookies(token),
      cookie(LOGIN, "", 0),
    ]);
  }

  /**
   * Null when the request carries the owner's session; else the answer: a sign-in for the page itself (`page`), 401
   * for its reads, 403 for someone else, 503 when lifelog's keys are out of reach.
   */
  async function refusal(req: Request, page = false) {
    const whose = await verify(cookieOf(req, SESSION) ?? "");
    if (!("refusal" in whose)) {
      return null;
    }
    const renewed = whose.refusal === "invalid" ? await renew(req) : "none";
    if (renewed instanceof Response) {
      return renewed;
    }
    if (whose.refusal === "forbidden") {
      return text("forbidden", 403);
    }
    if (whose.refusal === "unreachable") {
      return text(UNREACHABLE, 503);
    }
    // A refresh token the issuer refused is dropped, or every request would try it again (one it never saw, the issuer
    // being away, is kept: renew answered 503 then).
    const dropped = renewed === "refused" ? [cookie(REFRESH, "", 0)] : [];
    if (page) {
      const answer = login();
      for (const c of dropped) {
        answer.headers.append("set-cookie", c);
      }
      return answer;
    }
    return text(
      "sign in again",
      401,
      dropped.length ? { "set-cookie": dropped[0] as string } : {}
    );
  }

  /**
   * One trade at the issuer's token endpoint (a code or a refresh token): the owner's tokens, "refused" when the issuer
   * or the check says no, "unreachable" when the issuer or its keys can't be reached in time.
   */
  async function trade(fields: Record<string, string>) {
    const res = await lifelog(`${issuer}/oauth2/token`, {
      body: new URLSearchParams({ client_id: client, ...fields }),
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    // No answer, or the issuer's own failure (5xx): out of reach, not a refusal of the token.
    if (!res || res.status >= 500) {
      return "unreachable";
    }
    const token = Tokens.safeParse(
      res.ok ? await res.json().catch(() => null) : null
    );
    if (!token.success) {
      return "refused";
    }
    const whose = await verify(token.data.access_token);
    if ("refusal" in whose) {
      return whose.refusal === "unreachable" ? "unreachable" : "refused";
    }
    return token.data;
  }

  /**
   * A spent session renewed with its refresh token: the same address again, with the new cookies; a 503 when the issuer
   * can't be reached (the token kept); "refused" when the issuer said no; "none" with no refresh token.
   */
  async function renew(req: Request): Promise<Response | "none" | "refused"> {
    const refresh = cookieOf(req, REFRESH);
    if (!refresh) {
      return "none";
    }
    const token = await trade({
      grant_type: "refresh_token",
      refresh_token: refresh,
    });
    if (token === "unreachable") {
      return text(UNREACHABLE, 503);
    }
    if (token === "refused") {
      return token;
    }
    const { pathname, search } = new URL(req.url);
    // 307: a rating posted as the session ran out is posted again, with the new session.
    return redirect(`${pathname}${search}`, sessionCookies(token), 307);
  }

  return { callback, login, refusal };
}

export type SignIn = ReturnType<typeof createSignIn>;

/** The key the app reads its status with on this Mac, kept in Life's state (mode 600), made on first use. */
export const localKey = () => secretIn("localKey");
const BEARER = /^Bearer /;

/**
 * The local port's gate: the key as a bearer, compared in constant time, else refused. Read once: a new key takes a
 * restart.
 */
export function keyRefusal(key = localKey()) {
  return (req: Request) => {
    const given = req.headers.get("authorization")?.replace(BEARER, "") ?? "";
    return Promise.resolve(same(given, key) ? null : text("local only", 401));
  };
}
