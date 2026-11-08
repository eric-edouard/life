// How Life's server answers (`mcp.ts`), the one place for it: never cached, never framed,
// no referrer to other sites, fonts from Google Fonts only (Life's brand). Same-origin, not no-referrer: under no-referrer a browser posts a form with `Origin: null`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIFE_CODE_DIR } from "../../core/paths";

/** Life's brand tokens (assets/brand/tokens.css), for the pages that inline their styles. */
export const TOKENS = readFileSync(
  join(LIFE_CODE_DIR, "assets", "brand", "tokens.css"),
  "utf8"
);

export const HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

export const text = (
  body: string,
  status: number,
  headers: Record<string, string> = {}
) => new Response(body, { headers: { ...HEADERS, ...headers }, status });

/** Life's server on loopback: the port a tunnel forwards the connector's origin to (/mcp). */
export const PUBLIC_PORT = 46_200;
/** The app's status reads alone, by its local key: no tunnel ever points here. */
export const LOCAL_PORT = 46_201;
