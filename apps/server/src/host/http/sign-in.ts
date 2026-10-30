import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { MIN } from "../../core/clock";
import { same } from "../../core/secret";
import { connector } from "../../core/settings";
import { cookie, cookieOf, text } from "./http";

// His sign-in, for the web app and the legacy portrait alike: one password (LIFE_PORTRAIT_PASSWORD in .env). Signing in
// sets a cookie holding its expiry signed with the password, so changing the password signs every browser out.
// Nothing of his answers before `signedIn`.

const SESSION = "__Host-life-me";
const SESSION_S = 30 * 24 * 3600;
// ponytail: one global window for failed passwords, per-IP limits if it ever faces more than him.
const FAILS_ALLOWED = 5;
const FAILS_WINDOW_MS = MIN;

/** Where a signed-out visit to `path` goes: the app's sign-in, coming back after. */
export const signInFor = (path: string) =>
  `/sign-in?next=${encodeURIComponent(path)}`;

/** The cookie check and `POST /api/sign-in` (JSON `{password}`); none when no password is set. */
export function createSignIn(
  password = process.env.LIFE_PORTRAIT_PASSWORD,
  now = Date.now
) {
  if (!password) {
    return null;
  }
  const key = password;
  let fails: number[] = [];
  const sign = (exp: string) =>
    createHmac("sha256", key).update(`me:${exp}`).digest("base64url");

  function signedIn(req: Request) {
    const [exp = "", mac = ""] = (cookieOf(req, SESSION) ?? "").split(".");
    return Number(exp) * 1000 > now() && same(mac, sign(exp));
  }

  const app = new Hono().post("/api/sign-in", async (c) => {
    if (c.req.header("origin") !== connector().origin) {
      return text("forbidden", 403);
    }
    // Read the body before counting: nothing awaits between the check and the push, so a burst can't slip past.
    const body: unknown = await c.req.json().catch(() => null);
    const given =
      body && typeof body === "object" && "password" in body
        ? String(body.password)
        : "";
    fails = fails.filter((t) => now() - t < FAILS_WINDOW_MS);
    if (fails.length >= FAILS_ALLOWED) {
      return text("Too many tries, wait a minute.", 429);
    }
    if (!same(sign(given), sign(key))) {
      fails.push(now());
      return text("Wrong password.", 401);
    }
    const exp = String(Math.floor(now() / 1000) + SESSION_S);
    return text("ok", 200, {
      "set-cookie": cookie(SESSION, `${exp}.${sign(exp)}`, SESSION_S),
    });
  });
  return { app, signedIn };
}
export type SignIn = NonNullable<ReturnType<typeof createSignIn>>;
