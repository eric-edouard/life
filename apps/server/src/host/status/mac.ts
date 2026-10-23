import { statfsSync } from "node:fs";
import { freemem, totalmem, uptime } from "node:os";
import { clock, DAY } from "../../core/clock";
import { holder } from "../../core/lock";
import { LIFE_STATE_DIR, TEST } from "../../core/paths";
import { MAC } from "../../core/platform";
import { exec } from "../../core/proc";

// The machine Life runs on, as the status snapshot shows it (apps/server/src/host/status/snapshot.ts): up since, disk
// and memory, the archive and the watcher; on the Mac also its battery, the LaunchAgents and cloudflared, and its sleeps
// of the last day (a server has none of those). Read-only.

const WAKE_SEC = /sec = (\d+)/;
const BATTERY = /(\d+)%;\s*([^;]+)/;
const POWER_LINE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}) (Sleep|Wake)\s/;
const ZONE_OFFSET = / ([+-]\d{2})(\d{2})$/;
const PS_LINE = /^(\d+)\s+(.+)$/;

/** One read of this computer; a test run reads none, as it reads its own data and never this computer's; off the Mac, none. */
const machine = (cmd: string[], o?: Parameters<typeof exec>[1]) =>
  TEST || !MAC
    ? Promise.resolve({ code: 0, killed: null, stderr: "", stdout: "" })
    : exec(cmd, o);

/** The services launchd runs; the nightly tick runs every 30 min, so no process between ticks is fine. None off the Mac. */
const SERVICES = MAC
  ? [
      {
        label: "com.ericedouard.life.memory-nightly",
        name: "nightly tick",
        ticks: true,
      },
      { label: "com.eric.cloudflared", name: "cloudflared", ticks: false },
    ]
  : [];

const GB = 1e9;

/** When each process started, by pid (`ps`'s local start time). */
async function startedAt(pids: string[]) {
  if (pids.length === 0) {
    return new Map<string, string>();
  }
  const out = await machine(["ps", "-o", "pid=,lstart=", "-p", pids.join(",")]);
  return new Map(
    out.stdout
      .trim()
      .split("\n")
      .flatMap((l) => {
        const [, pid, start] = l.trim().match(PS_LINE) ?? [];
        const at = start ? new Date(start) : null;
        return pid && at && !Number.isNaN(at.getTime())
          ? [[pid, at.toISOString()] as const]
          : [];
      })
  );
}

export async function macState() {
  const [list, batt, wake] = await Promise.all([
    machine(["launchctl", "list"]),
    machine(["pmset", "-g", "batt"]),
    machine(["sysctl", "-n", "kern.waketime"]),
  ]);
  const rows = new Map(
    list.stdout.split("\n").map((l) => {
      const [pid, status, label] = l.split("\t");
      return [label, { pid, status }] as const;
    })
  );
  const started = await startedAt(
    SERVICES.flatMap((s) => {
      const pid = rows.get(s.label)?.pid;
      return pid && pid !== "-" ? [pid] : [];
    })
  );
  // The Mac's last wake; elsewhere its boot.
  const sec = MAC
    ? Number(wake.stdout.match(WAKE_SEC)?.[1] ?? 0)
    : Math.round(clock().getTime() / 1000 - uptime());
  // The disk Life's state is on (a server's data volume).
  const disk = statfsSync(LIFE_STATE_DIR);
  // The archive and the watcher, whoever runs them (launchd or the app): who holds each one's lock (`hold`, lock.ts).
  const held = (["archive", "watch"] as const).map((name) => {
    const h = holder(name);
    return {
      name,
      ok: !!h,
      running: !!h,
      since: h?.since.toISOString() ?? null,
      status: h ? "running" : "nothing holds its lock",
    };
  });
  return {
    awakeSince: sec ? new Date(sec * 1000).toISOString() : null,
    battery: MAC
      ? (batt.stdout.match(BATTERY)?.slice(1, 3).join(", ") ?? "?")
      : null,
    freeGb: Math.round((disk.bavail * disk.bsize) / GB),
    memory: {
      freeGb: Math.round((freemem() / GB) * 10) / 10,
      totalGb: Math.round(totalmem() / GB),
    },
    services: [
      ...held,
      ...SERVICES.map((s) => {
        const r = rows.get(s.label);
        const running = !!r && r.pid !== "-";
        return {
          name: s.name,
          ok: running || (s.ticks && r?.status === "0"),
          running,
          /** When its process started: launchd's restart after a crash or a commit, the tunnel's after a heal. */
          since: r ? (started.get(r.pid ?? "") ?? null) : null,
          status: r ? `last exit ${r.status}` : "not loaded",
        };
      }),
    ],
  };
}

/** The Mac's sleeps since `now` less a day, from the power log. */
export async function sleeps(now: number) {
  const out = await machine(["pmset", "-g", "log"], { timeout: 20_000 });
  const list: { at: string; end?: string }[] = [];
  for (const line of out.stdout.split("\n")) {
    const m = line.match(POWER_LINE);
    const at = m?.[1]
      ? new Date(m[1].replace(" ", "T").replace(ZONE_OFFSET, "$1:$2")).getTime()
      : 0;
    if (at < now - DAY) {
      continue;
    }
    const open = list.at(-1);
    if (m?.[2] === "Sleep") {
      list.push({ at: new Date(at).toISOString() });
    } else if (open && !open.end) {
      open.end = new Date(at).toISOString();
    }
  }
  return list;
}
