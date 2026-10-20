import { createHmac, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { ORIGIN } from "./auth";
import { cookie, cookieOf, HEADERS, redirect, text } from "./http";
import { DATA } from "./truth";

// The portrait (/me): pages about him and his people, written from his memory into DATA/docs/portrait/ (his data,
// never in this repo): /me is index.html, /me/<name> is <name>.html. Behind a password (LIFE_PORTRAIT_PASSWORD in
// .env). Signing in sets a cookie holding its expiry signed with the password, so changing the password signs every
// browser out. Nothing of his answers before that check.

const SESSION = "__Host-life-me";
const SESSION_S = 30 * 24 * 3600;
const PAGES = join(DATA, "docs", "portrait");
const ROUTE = /^\/me(?:\/[a-z0-9-]+)?$/;
// ponytail: one global window for failed passwords, per-IP limits if it ever faces more than him.
const FAILS_ALLOWED = 5;
const FAILS_WINDOW_MS = 60_000;
// The page and the form load Google Fonts and inline styles, nothing else: no images, no scripts.
const PAGE_HEADERS = {
  ...HEADERS,
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; frame-ancestors 'none'",
  "content-type": "text/html; charset=utf-8",
  "x-robots-tag": "noindex",
};

const form = (
  action: string,
  note = ""
) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Life</title>
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f7f5;color:#1b1d1f;font:16px/1.55 "Source Serif 4",Georgia,serif}
form{display:grid;gap:12px;width:min(320px,calc(100vw - 32px))}h1{font-size:28px;margin:0}
input,button{font:inherit;padding:9px 12px;border-radius:5px;border:1px solid #e1e2de;background:#fff}
button{background:#1b1d1f;color:#fff;border-color:#1b1d1f;font-weight:600;cursor:pointer}p{margin:0;color:#c4382c;font:500 12px "IBM Plex Mono",monospace}</style>
<form method="post" action="${action}"><h1>Life</h1><input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required><button>Open</button>${note ? `<p>${note}</p>` : ""}</form>`;

/** The /me and /me/<name> routes; `handle` resolves to null for any other path, and for every path when no password is set. */
export function createPortrait(
  password = process.env.LIFE_PORTRAIT_PASSWORD,
  pages = PAGES,
  now = Date.now
) {
  if (!password) {
    return { handle: async (_req: Request): Promise<Response | null> => null };
  }
  const key = password;
  let fails: number[] = [];
  const sign = (exp: string) =>
    createHmac("sha256", key).update(`me:${exp}`).digest("base64url");
  const same = (a: string, b: string) =>
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  function signedIn(req: Request) {
    const [exp = "", mac = ""] = (cookieOf(req, SESSION) ?? "").split(".");
    return Number(exp) * 1000 > now() && same(mac, sign(exp));
  }

  async function login(req: Request, pathname: string) {
    if (req.headers.get("origin") !== ORIGIN) {
      return text("forbidden", 403);
    }
    // Read the form before counting: nothing awaits between the check and the push, so a burst can't slip past.
    const given = String(
      (await req.formData().catch(() => null))?.get("password") ?? ""
    );
    fails = fails.filter((t) => now() - t < FAILS_WINDOW_MS);
    if (fails.length >= FAILS_ALLOWED) {
      return text(
        form(pathname, "Too many tries, wait a minute."),
        429,
        PAGE_HEADERS
      );
    }
    if (!same(sign(given), sign(key))) {
      fails.push(now());
      return text(form(pathname, "Wrong password."), 401, PAGE_HEADERS);
    }
    const exp = String(Math.floor(now() / 1000) + SESSION_S);
    return redirect(pathname, [
      cookie(SESSION, `${exp}.${sign(exp)}`, SESSION_S),
    ]);
  }

  async function handle(req: Request): Promise<Response | null> {
    const { pathname } = new URL(req.url);
    if (!ROUTE.test(pathname)) {
      return null;
    }
    if (req.method === "POST") {
      return login(req, pathname);
    }
    if (!signedIn(req)) {
      return text(form(pathname), 200, PAGE_HEADERS);
    }
    const file = Bun.file(
      join(pages, `${pathname.slice("/me/".length) || "index"}.html`)
    );
    return (await file.exists())
      ? new Response(file, { headers: PAGE_HEADERS })
      : text("no such page", 404);
  }

  return { handle };
}
