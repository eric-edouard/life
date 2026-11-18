// How Life's server answers (`mcp.ts`), the one place for it: never cached, never framed,
// no referrer to other sites, fonts from Google Fonts only (Life's brand). Same-origin, not no-referrer: under no-referrer a browser posts a form with `Origin: null`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIFE_CODE_DIR } from "../../core/paths";
import { isOwnLife } from "../../core/platform";

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

const DIGITS = /^\d+$/;
/** Life's own public port: the one its tunnel forwards to (`tailscale.ts`). */
export const OWN_PORT = 46_200;
/** `LIFE_PORT` as a port with room for the two after it; unset, Life's own. A second Life only: never with his own data. */
export function portOf(set = process.env.LIFE_PORT, isOwn = isOwnLife()) {
  if (set === undefined) {
    return OWN_PORT;
  }
  const port = Number(set);
  if (!(DIGITS.test(set) && port >= 1024 && port <= 65_533)) {
    throw new Error(`LIFE_PORT ${set} is not a port from 1024 to 65533`);
  }
  if (isOwn && port !== OWN_PORT) {
    throw new Error("LIFE_PORT is for a second Life, never his own data");
  }
  return port;
}
/**
 * Life's server on loopback: the port a tunnel forwards the connector's origin to (/mcp). `LIFE_PORT` moves it and the
 * two after it, for a second Life on this Mac (a demo, `scripts/demo.ts`).
 */
export const PUBLIC_PORT = portOf();
/** The app's status reads alone, by its local key: no tunnel ever points here. */
export const LOCAL_PORT = PUBLIC_PORT + 1;
/** The desk's door (`desk/desk-door.ts`): its registered agents' MCP, on loopback only, one key per agent. */
export const DOOR_PORT = PUBLIC_PORT + 2;
