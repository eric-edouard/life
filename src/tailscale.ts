import { existsSync } from "node:fs";
import { z } from "zod";
import { exec } from "./proc";
import { setSettings, settings } from "./settings";

// How the connector is reached with no domain of his own: Tailscale. `serve` puts Life's server on his tailnet, for
// his phone and his own computers; `funnel` puts it on the internet, for the agents that call from their makers'
// clouds (ChatGPT, Claude.ai), and Life's own sign-in (`oauth.ts`) guards it there. Either way the address is his
// Mac's tailnet name, and it becomes the connector's origin.

/** The Mac app's own command line, or one on the PATH. */
const BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const tailscale = (args: string[]) =>
  exec([existsSync(BIN) ? BIN : "tailscale", ...args], { timeout: 30_000 });

const TRAILING_DOT = /\.$/;
/** Where Life's server listens (`server.ts`). */
const LOCAL = "http://127.0.0.1:46200";

const Status = z.object({
  BackendState: z.string(),
  Self: z.object({ DNSName: z.string() }),
});

/** This Mac's name on its tailnet, from Tailscale itself; an error says what to fix first. */
export async function tailnetName() {
  const r = await tailscale(["status", "--json"]);
  if (r.code !== 0) {
    throw new Error(`Tailscale is not running: ${r.stderr.trim()}`);
  }
  const s = Status.parse(JSON.parse(r.stdout));
  if (s.BackendState !== "Running") {
    throw new Error(`Tailscale is ${s.BackendState}: sign in first`);
  }
  return s.Self.DNSName.replace(TRAILING_DOT, "");
}

/**
 * Serves Life on this Mac's tailnet name (port 443): on his tailnet only, or `public` through Funnel for ChatGPT and
 * Claude.ai. Its origin becomes the connector's, and the Cloudflare tunnel's healer stops (`tunnel: tailscale`).
 */
export async function connect(publicToo: boolean) {
  const name = await tailnetName();
  const r = await tailscale([
    publicToo ? "funnel" : "serve",
    "--bg",
    "--https=443",
    LOCAL,
  ]);
  if (r.code !== 0) {
    throw new Error(
      `tailscale ${publicToo ? "funnel" : "serve"}: ${r.stderr.trim()}`
    );
  }
  const origin = `https://${name}`;
  await setSettings({
    connector: { ...settings().connector, origin, tunnel: "tailscale" },
  });
  return origin;
}
