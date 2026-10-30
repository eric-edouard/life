import { join } from "node:path";
import { type Context, Hono } from "hono";
import { LIFE_CODE_DIR, OWNER_DATA_DIR } from "../../core/paths";
import { HEADERS, redirect, text } from "./http";
import { type SignIn, signInFor } from "./sign-in";

// The portrait (/me), parked as legacy: a one-off set of pages about him and his people, written once into
// OWNER_DATA_DIR/docs/portrait/ (his data, never in this repo) and served as they are: /me is index.html, /me/<name>
// is <name>.html. Behind his sign-in (`sign-in.ts`): nothing of his answers before it.

const PAGES = join(OWNER_DATA_DIR, "docs", "portrait");
const PAGE = /^\/me(?:\/[a-z0-9-]+)?$/;
// A page's clips: its audio and the words timed to it, in <page>/clips/ (nothing else of the page's folder is served).
const CLIP = /^\/me\/[a-z0-9-]+\/clips\/[a-z0-9-]+\.(?:m4a|json)$/;
// The clip player is code, so it ships in this repo; the pages and clips are his data.
const PLAYER = "/me/player.js";
// The pages load Google Fonts, inline styles, the player and their clips from here, nothing else: no images.
const PAGE_HEADERS = {
  ...HEADERS,
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; media-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  "x-robots-tag": "noindex",
};

/** What a path under /me serves (a page, one of its clips, the player), or null for a path that isn't the portrait's. */
const fileOf = (pages: string, pathname: string) => {
  const name = pathname.slice("/me/".length);
  if (pathname === PLAYER) {
    return {
      page: false,
      path: join(LIFE_CODE_DIR, "assets", "portrait", "player.js"),
    };
  }
  if (CLIP.test(pathname)) {
    return { page: false, path: join(pages, name) };
  }
  return PAGE.test(pathname)
    ? { page: true, path: join(pages, `${name || "index"}.html`) }
    : null;
};

/** The /me and /me/<name> routes; a signed-out visit to a page goes to the app's sign-in. */
export function createPortrait(signIn: SignIn, pages = PAGES) {
  async function serve(c: Context) {
    const { pathname } = new URL(c.req.url);
    const served = fileOf(pages, pathname);
    if (!served) {
      return c.notFound();
    }
    if (!signIn.signedIn(c.req.raw)) {
      return served.page
        ? redirect(signInFor(pathname))
        : text("sign in at /sign-in", 401);
    }
    const file = Bun.file(served.path);
    if (!(await file.exists())) {
      return text("not found", 404);
    }
    return new Response(file, {
      headers: served.page
        ? { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8" }
        : PAGE_HEADERS,
    });
  }

  // `/me/*` matches `/me` too; `/me/decisions` is the web app's (its old address).
  return new Hono().get("/me/*", (c, next) =>
    c.req.path === "/me/decisions" ? next() : serve(c)
  );
}
