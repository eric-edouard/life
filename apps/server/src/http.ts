// How Life's server answers (`mcp.ts`, `check.ts`, `portrait.ts`), the one place for it: never cached, never framed,
// no referrer to other sites, fonts from Google Fonts only (Life's brand). Same-origin, not no-referrer: under no-referrer a browser posts a form with `Origin: null`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./core/paths";

/** Life's brand tokens (assets/brand/tokens.css), for the pages that inline their styles. */
export const TOKENS = readFileSync(
  join(ROOT, "assets", "brand", "tokens.css"),
  "utf8"
);

export const HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

/** The owner's session cookie, set by the sign-in (`signin.ts`). */
export const SESSION = "__Host-life";

/** An HttpOnly, Secure, SameSite=Lax cookie for the whole site, as a Set-Cookie value. */
export const cookie = (name: string, value: string, maxAge: number) =>
  new Bun.Cookie(name, value, {
    httpOnly: true,
    maxAge,
    path: "/",
    sameSite: "lax",
    secure: true,
  }).serialize();

/** A redirect with cookies: 302, or 307 to send a request again as it was (a POST stays a POST). */
export const redirect = (to: string, cookies: string[] = [], status = 302) => {
  const headers = new Headers({ ...HEADERS, location: to });
  for (const c of cookies) {
    headers.append("set-cookie", c);
  }
  return new Response(null, { headers, status });
};

export const cookieOf = (req: Request, name: string) =>
  new Bun.CookieMap(req.headers.get("cookie") ?? "").get(name);

export const text = (
  body: string,
  status: number,
  headers: Record<string, string> = {}
) => new Response(body, { headers: { ...HEADERS, ...headers }, status });

/** Life's server on loopback: the port a tunnel forwards the connector's origin to (/mcp, /check, /me). */
export const PUBLIC_PORT = 46_200;
/** The app's status reads alone, by its local key: no tunnel ever points here. */
export const LOCAL_PORT = 46_201;
