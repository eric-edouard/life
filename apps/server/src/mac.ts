import { holder } from "./lock";
import { exec } from "./proc";
import { TEST } from "./truth";

// The Mac Life runs on, as the status plate shows it (apps/server/src/plate.ts): awake since, battery, disk, the LaunchAgents and
// cloudflared, and its sleeps of the last day. Read-only.

const WAKE_SEC = /sec = (\d+)/;
const SPACES = /\s+/;
const BATTERY = /(\d+)%;\s*([^;]+)/;
const POWER_LINE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}) (Sleep|Wake)\s/;
const ZONE_OFFSET = / ([+-]\d{2})(\d{2})$/;
const DAY = 86_400_000;
const PS_LINE = /^(\d+)\s+(.+)$/;

/** One read of this computer; a test run reads none, as it reads its own data and never this computer's. */
const machine = (cmd: string[], o?: Parameters<typeof exec>[1]) =>
  TEST
    ? Promise.resolve({ code: 0, killed: null, stderr: "", stdout: "" })
    : exec(cmd, o);

/** The services launchd runs; the nightly tick runs every 30 min, so no process between ticks is fine. */
const SERVICES = [
  {
    label: "com.ericedouard.life.memory-nightly",
    name: "nightly tick",
    ticks: true,
  },
  { label: "com.eric.cloudflared", name: "cloudflared", ticks: false },
];

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
  const [list, batt, disk, wake] = await Promise.all([
    machine(["launchctl", "list"]),
    machine(["pmset", "-g", "batt"]),
    machine(["df", "-k", "/"]),
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
  const sec = Number(wake.stdout.match(WAKE_SEC)?.[1] ?? 0);
  const free =
    Number(disk.stdout.trim().split("\n").at(-1)?.split(SPACES)[3] ?? 0) * 1024;
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
    battery: batt.stdout.match(BATTERY)?.slice(1, 3).join(", ") ?? "?",
    freeGb: Math.round(free / 1e9),
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
