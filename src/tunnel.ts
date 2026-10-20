import { ORIGIN } from "./auth";
import { exec } from "./proc";

// The Mac's Cloudflare tunnel (`com.eric.cloudflared`, `~/.cloudflared/config.yml`) carries the connector and the
// other hostnames on this Mac. cloudflared can wedge: its edge connections die but the process never exits, so
// launchd's KeepAlive never fires. Every 2 minutes the watcher probes the connector through the tunnel and restarts
// it only when Cloudflare says it has no tunnel to us (530) or nothing answered while the internet is up.

const EVERY_MS = 2 * 60_000;
const PROBE = `${ORIGIN}/.well-known/oauth-protected-resource/mcp`;

/** The probe's HTTP status (0: no answer) means the tunnel is down. Any other answer (a 502 from a dead app behind it included) means Cloudflare reached the Mac. */
export const tunnelDown = (status: number) => status === 530 || status === 0;

const statusOf = (url: string) =>
  fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) }).then(
    (r) => r.status,
    () => 0
  );

let probedAt = 0;

/** Probes at most every 2 minutes; restarts cloudflared when the tunnel is down and the internet is not. */
export async function healTunnel(now = Date.now()) {
  if (now - probedAt < EVERY_MS) {
    return;
  }
  probedAt = now;
  const status = await statusOf(PROBE);
  if (!tunnelDown(status) || (await statusOf("https://1.1.1.1")) === 0) {
    return;
  }
  console.log(
    `${new Date(now).toISOString()} tunnel: ${status || "no answer"}, restarting cloudflared`
  );
  await exec([
    "launchctl",
    "kickstart",
    "-k",
    `gui/${process.getuid?.()}/com.eric.cloudflared`,
  ]);
}
