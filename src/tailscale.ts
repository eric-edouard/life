import { existsSync } from "node:fs";
import { z } from "zod";
import { PUBLIC_PORT } from "./http";
import { execOk } from "./proc";
import { setSettings, settings } from "./settings";

// How the connector is reached with no domain of his own: Tailscale. `serve` puts Life's server on his tailnet, for
// his phone and his own computers; `funnel` puts it on the internet, for the agents that call from their makers'
// clouds (ChatGPT, Claude.ai), and Life's own sign-in (`oauth.ts`) guards it there. Either way the address is his
// Mac's tailnet name, and it becomes the connector's origin.

/** The Mac app's own command line, or one on the PATH. */
const BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const tailscale = (args: string[]) =>
  execOk([existsSync(BIN) ? BIN : "tailscale", ...args], { timeout: 30_000 });

const TRAILING_DOT = /\.$/;
/** Where Life's server listens (`server.ts`). */
/** Life's public port, the one a tunnel may reach. */
const SERVER = `http://127.0.0.1:${PUBLIC_PORT}`;

const Status = z.object({
  BackendState: z.string(),
  Self: z.object({ DNSName: z.string() }),
});

/** This Mac's name on its tailnet, from Tailscale itself; an error says what to fix first. */
export async function tailnetName() {
  const s = Status.parse(
    JSON.parse(
      await tailscale(["status", "--json"]).catch((e: Error) => {
        throw new Error(`Tailscale is not running: ${e.message}`);
      })
    )
  );
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
  await tailscale([
    publicToo ? "funnel" : "serve",
    "--bg",
    "--https=443",
    SERVER,
  ]);
  const origin = `https://${name}`;
  setSettings({
    connector: { ...settings().connector, origin, tunnel: "tailscale" },
  });
  return origin;
}
