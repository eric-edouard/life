import { createHmac } from "node:crypto";
import { join } from "node:path";
import { type Context, Hono } from "hono";
import { MIN } from "../../core/clock";
import { LIFE_CODE_DIR, OWNER_DATA_DIR } from "../../core/paths";
import { same } from "../../core/secret";
import { connector } from "../../core/settings";
import { decisionsNow, writeDecision } from "../../memory/decisions";
import { OWNER_STEPS } from "../../records/decision";
import { startAgent, wakeOf } from "../events";
import { recipientOf } from "../send";
import { cookie, cookieOf, HEADERS, redirect, TOKENS, text } from "./http";

// The portrait (/me): pages about him and his people, written from his memory into OWNER_DATA_DIR/docs/portrait/ (his data,
// never in this repo): /me is index.html, /me/<name> is <name>.html. Behind a password (LIFE_PORTRAIT_PASSWORD in
// .env). Signing in sets a cookie holding its expiry signed with the password, so changing the password signs every
// browser out. Nothing of his answers before that check.

const SESSION = "__Host-life-me";
const SESSION_S = 30 * 24 * 3600;
const PAGES = join(OWNER_DATA_DIR, "docs", "portrait");
const PAGE = /^\/me(?:\/[a-z0-9-]+)?$/;
// A page's clips: its audio and the words timed to it, in <page>/clips/ (nothing else of the page's folder is served).
const CLIP = /^\/me\/[a-z0-9-]+\/clips\/[a-z0-9-]+\.(?:m4a|json)$/;
// The clip player is code, so it ships in this repo; the pages and clips are his data.
const PLAYER = "/me/player.js";
// His decisions' page and its script are code too (assets/decisions/); what it shows is memory/decisions.jsonl, read
// and answered through DECISIONS_JSON behind the same sign-in.
const DECISIONS_PAGE = "/me/decisions";
const DECISIONS_SCRIPT = "/me/decisions.js";
const DECISIONS_JSON = "/me/decisions.json";
// ponytail: one global window for failed passwords, per-IP limits if it ever faces more than him.
const FAILS_ALLOWED = 5;
const FAILS_WINDOW_MS = MIN;
// The pages load Google Fonts, inline styles, the player and their clips from here, nothing else: no images.
const PAGE_HEADERS = {
  ...HEADERS,
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; media-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  "x-robots-tag": "noindex",
};

// Bun types each file from its extension; the pages Life writes as strings (the sign-in form, the decisions page) say they are HTML.
const HTML_HEADERS = {
  ...PAGE_HEADERS,
  "content-type": "text/html; charset=utf-8",
};

/** What a path under /me serves (a page, one of its clips, the player), or null for a path that isn't the portrait's. */
const fileOf = (pages: string, pathname: string) => {
  const name = pathname.slice("/me/".length);
  if (pathname === DECISIONS_PAGE || pathname === DECISIONS_SCRIPT) {
    return {
      page: pathname === DECISIONS_PAGE,
      path: join(
        LIFE_CODE_DIR,
        "assets",
        "decisions",
        pathname === DECISIONS_PAGE ? "index.html" : "decisions.js"
      ),
    };
  }
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

const form = (
  action: string,
  note = ""
) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Life</title>
<style>${TOKENS}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--white);color:var(--ink);font:17px/1.55 var(--sans)}
form{display:grid;gap:12px;width:min(320px,calc(100vw - 32px))}h1{font:600 36px/1.1 var(--serif);margin:0 0 12px}
input,button{font:inherit;color:inherit;padding:11px 16px;border-radius:var(--control-radius);border:1px solid var(--rule);background:var(--surface)}
button{background:var(--ink);color:var(--white);border-color:var(--ink);font-weight:600;cursor:pointer}p{margin:0;font:500 11.5px/1.5 var(--mono)}p::before{content:"● ";color:var(--error)}</style>
<form method="post" action="${action}"><h1>Life</h1><input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required><button>Open</button>${note ? `<p>${note}</p>` : ""}</form>`;

/** The /me and /me/<name> routes; none when no password is set. */
export function createPortrait(
  password = process.env.LIFE_PORTRAIT_PASSWORD,
  pages = PAGES,
  now = Date.now
) {
  if (!password) {
    return new Hono();
  }
  const key = password;
  let fails: number[] = [];
  const sign = (exp: string) =>
    createHmac("sha256", key).update(`me:${exp}`).digest("base64url");

  function signedIn(req: Request) {
    const [exp = "", mac = ""] = (cookieOf(req, SESSION) ?? "").split(".");
    return Number(exp) * 1000 > now() && same(mac, sign(exp));
  }

  async function login(req: Request, pathname: string) {
    if (req.headers.get("origin") !== connector().origin) {
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
        HTML_HEADERS
      );
    }
    if (!same(sign(given), sign(key))) {
      fails.push(now());
      return text(form(pathname, "Wrong password."), 401, HTML_HEADERS);
    }
    const exp = String(Math.floor(now() / 1000) + SESSION_S);
    return redirect(pathname, [
      cookie(SESSION, `${exp}.${sign(exp)}`, SESSION_S),
    ]);
  }

  /** His decisions as they stand (GET), or his step on one (POST: answered, context, revoked, or asked, his request). */
  async function decisions(req: Request) {
    if (!signedIn(req)) {
      return text("sign in at /me", 401);
    }
    if (req.method !== "POST") {
      const all = [...decisionsNow().values()].map((d) => ({
        ...d,
        // Only an open card asks his tap: the others need no recipient read.
        to: d.status === "open" ? recipientOf(d.ref) : undefined,
      }));
      return text(JSON.stringify(all), 200, {
        ...HEADERS,
        "content-type": "application/json",
      });
    }
    if (req.headers.get("origin") !== connector().origin) {
      return text("forbidden", 403);
    }
    const b = (await req.json().catch(() => ({}))) as {
      data?: Record<string, unknown>;
      decision?: string;
      step?: string;
    };
    if (!OWNER_STEPS.includes(b.step as (typeof OWNER_STEPS)[number])) {
      return text("unknown step", 400);
    }
    try {
      if (b.step === "asked") {
        // His "Something's wrong": a request (no options) about one loop, for the audit; Life makes its id.
        const { loop, note, ref } = (b.data ?? {}) as Partial<
          Record<string, string>
        >;
        const at = new Date(now()).toISOString().replace(/\D/g, "");
        const ask = {
          context: note,
          kind: "audit",
          loop,
          options: [],
          question: `${note ?? ""}`.slice(0, 200),
          ref,
        };
        writeDecision(
          [
            {
              data: ask,
              decision: `${loop}-${at.slice(0, 17)}-1`,
              step: "asked",
            },
          ],
          now()
        );
      } else {
        const [d] = writeDecision(
          [
            {
              data: b.data,
              decision: `${b.decision}`,
              step: b.step as "answered",
            },
          ],
          now()
        );
        const wake = wakeOf(`${b.step}`, d?.loop);
        if (wake) {
          startAgent(wake);
        }
      }
      return text("ok", 200);
    } catch (e) {
      return text((e as Error).message, 409);
    }
  }

  async function serve(c: Context) {
    const req = c.req.raw;
    const { pathname } = new URL(req.url);
    if (pathname === DECISIONS_JSON) {
      return decisions(req);
    }
    const served = fileOf(pages, pathname);
    if (!served) {
      return c.notFound();
    }
    const { page, path } = served;
    if (page && req.method === "POST") {
      return login(req, pathname);
    }
    if (!signedIn(req)) {
      return page
        ? text(form(pathname), 200, HTML_HEADERS)
        : text("sign in at /me", 401);
    }
    const file = Bun.file(path);
    if (pathname === DECISIONS_PAGE) {
      // Life's brand, its one source: the tokens go in as it is served.
      return text(
        (await file.text()).replace("/*TOKENS*/", TOKENS),
        200,
        HTML_HEADERS
      );
    }
    return (await file.exists())
      ? new Response(file, { headers: PAGE_HEADERS })
      : text("not found", 404);
  }

  // `/me/*` matches `/me` too.
  return new Hono().all("/me/*", serve);
}
