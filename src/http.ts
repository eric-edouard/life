// How Life's server answers (`mcp.ts`, `check.ts`, `portrait.ts`), the one place for it: never cached, never framed,
// no referrer.

export const HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** An HttpOnly, Secure, SameSite=Lax cookie for the whole site, as a Set-Cookie value. */
export const cookie = (name: string, value: string, maxAge: number) =>
  new Bun.Cookie(name, value, {
    httpOnly: true,
    maxAge,
    path: "/",
    sameSite: "lax",
    secure: true,
  }).serialize();

export const redirect = (to: string, cookies: string[] = []) => {
  const headers = new Headers({ ...HEADERS, location: to });
  for (const c of cookies) {
    headers.append("set-cookie", c);
  }
  return new Response(null, { headers, status: 302 });
};

export const cookieOf = (req: Request, name: string) =>
  new Bun.CookieMap(req.headers.get("cookie") ?? "").get(name);

export const text = (
  body: string,
  status: number,
  headers: Record<string, string> = {}
) => new Response(body, { headers: { ...HEADERS, ...headers }, status });
