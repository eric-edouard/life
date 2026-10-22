import { clock } from "./clock";
import { exec } from "./proc";
import { connector, settings } from "./settings";

// The Mac's Cloudflare tunnel (`com.eric.cloudflared`, `~/.cloudflared/config.yml`). cloudflared can wedge: its edge
// connections die but the process never exits, so launchd's KeepAlive never fires. Every 2 minutes the watcher probes
// the connector's metadata and restarts cloudflared only when Cloudflare answers that it has no tunnel to us (530). No
// answer is not the tunnel: the Mac is offline, or this process (which also serves the connector) was busy past the
// timeout, as on 20 Oct when it restarted a healthy tunnel. Behind the edge Worker (worker/edge.ts) that address never
// answers 530, so this no longer fires and the tunnel's other hostnames have no heal: deleting it is #133.

export const TUNNEL_EVERY_MS = 2 * 60_000;

/** Only Cloudflare's 530 (no tunnel to us) means the tunnel is down; no answer (0) or any other status does not. */
export const tunnelDown = (status: number) => status === 530;

const statusOf = (url: string) =>
  fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) }).then(
    (r) => r.status,
    () => 0
  );

/** One probe: restarts cloudflared when the tunnel is down; nothing to probe without a Cloudflare tunnel. */
export async function healTunnel() {
  if (
    !(
      settings().connector?.tunnel === "cloudflare" &&
      tunnelDown(await statusOf(connector().metadata))
    )
  ) {
    return;
  }
  console.log(`${clock().toISOString()} tunnel: 530, restarting cloudflared`);
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
