import { clock, MIN } from "../../core/clock";
import { TUNNEL_RESTART } from "../../core/platform";
import { exec } from "../../core/proc";
import { connector, settings } from "../../core/settings";

// The Mac's Cloudflare tunnel (`com.eric.cloudflared`, `~/.cloudflared/config.yml`). cloudflared can wedge: its edge
// connections die but the process never exits, so launchd's KeepAlive never fires. Every 2 minutes the watcher probes
// the connector's metadata and restarts cloudflared only when Cloudflare answers that it has no tunnel to us (530). No
// answer is not the tunnel: the Mac is offline, or this process (which also serves the connector) was busy past the
// timeout, as on 20 Oct when it restarted a healthy tunnel. Behind the edge Worker (apps/edge/edge.ts) that address never
// answers 530, so this no longer fires and the tunnel's other hostnames have no heal: deleting it is #133.

export const TUNNEL_EVERY_MS = 2 * MIN;

/** Only Cloudflare's 530 (no tunnel to us) means the tunnel is down; no answer (0) or any other status does not. */
export const tunnelDown = (status: number) => status === 530;

/** What `url` answers: its status, or 0 when nothing answered in 15 s. */
export const statusOf = (url: string, method = "HEAD") =>
  fetch(url, { method, signal: AbortSignal.timeout(15_000) }).then(
    (r) => r.status,
    () => 0
  );

/** One probe: restarts cloudflared when the tunnel is down; nothing to probe without a Cloudflare tunnel this Mac runs. */
export async function healTunnel() {
  if (
    !(
      TUNNEL_RESTART &&
      settings().connector?.tunnel === "cloudflare" &&
      tunnelDown(await statusOf(connector().metadata))
    )
  ) {
    return;
  }
  console.log(`${clock().toISOString()} tunnel: 530, restarting cloudflared`);
  const { code, stderr } = await exec(TUNNEL_RESTART);
  if (code !== 0) {
    throw new Error(`launchctl kickstart exited ${code}: ${stderr.trim()}`);
  }
}
