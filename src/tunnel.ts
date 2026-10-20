import { METADATA } from "./auth";
import { exec } from "./proc";

// The Mac's Cloudflare tunnel (`com.eric.cloudflared`, `~/.cloudflared/config.yml`) carries the connector and the
// other hostnames on this Mac. cloudflared can wedge: its edge connections die but the process never exits, so
// launchd's KeepAlive never fires. Every 2 minutes the watcher probes the connector through the tunnel and restarts
// it only when Cloudflare answers that it has no tunnel to us (530). No answer is not the tunnel: the Mac is offline,
// or this process (which also serves the connector) was busy past the timeout, as on 20 Oct when it restarted a
// healthy tunnel.

export const TUNNEL_EVERY_MS = 2 * 60_000;

/** The probe's HTTP status (0: no answer) means the tunnel is down: only Cloudflare's 530. Any other answer (a dead app's 502 included) means it reached the Mac. */
export const tunnelDown = (status: number) => status === 530;

const statusOf = (url: string) =>
  fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) }).then(
    (r) => r.status,
    () => 0
  );

/** One probe: restarts cloudflared when the tunnel is down. */
export async function healTunnel() {
  if (!tunnelDown(await statusOf(METADATA))) {
    return;
  }
  console.log(
    `${new Date().toISOString()} tunnel: 530, restarting cloudflared`
  );
  const { code, stderr } = await exec([
    "launchctl",
    "kickstart",
    "-k",
    `gui/${process.getuid?.()}/com.eric.cloudflared`,
  ]);
  if (code !== 0) {
    throw new Error(`launchctl kickstart exited ${code}: ${stderr.trim()}`);
  }
}
