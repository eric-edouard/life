import { exec } from "./proc";

// The Mac Life runs on, as the status page shows it (src/plate.ts): awake since, battery, disk, the LaunchAgents and
// cloudflared, and its sleeps of the last day. Read-only.

const WAKE_SEC = /sec = (\d+)/;
const SPACES = /\s+/;
const BATTERY = /(\d+)%;\s*([^;]+)/;
const POWER_LINE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}) (Sleep|Wake)\s/;
const ZONE_OFFSET = / ([+-]\d{2})(\d{2})$/;
const DAY = 86_400_000;

/** The services Life runs on the Mac; the nightly tick runs every 30 min, so no process between ticks is fine. */
const SERVICES = [
  { label: "com.ericedouard.life.archive", name: "archive", ticks: false },
  { label: "com.ericedouard.life.watch", name: "watch", ticks: false },
  {
    label: "com.ericedouard.life.memory-nightly",
    name: "nightly tick",
    ticks: true,
  },
  { label: "com.eric.cloudflared", name: "cloudflared", ticks: false },
];

export async function macState() {
  const [list, batt, disk, wake] = await Promise.all([
    exec(["launchctl", "list"]),
    exec(["pmset", "-g", "batt"]),
    exec(["df", "-k", "/"]),
    exec(["sysctl", "-n", "kern.waketime"]),
  ]);
  const rows = new Map(
    list.stdout.split("\n").map((l) => {
      const [pid, status, label] = l.split("\t");
      return [label, { pid, status }] as const;
    })
  );
  const sec = Number(wake.stdout.match(WAKE_SEC)?.[1] ?? 0);
  const free =
    Number(disk.stdout.trim().split("\n").at(-1)?.split(SPACES)[3] ?? 0) * 1024;
  return {
    awakeSince: sec ? new Date(sec * 1000).toISOString() : null,
    battery: batt.stdout.match(BATTERY)?.slice(1, 3).join(", ") ?? "?",
    freeGb: Math.round(free / 1e9),
    services: SERVICES.map((s) => {
      const r = rows.get(s.label);
      const running = !!r && r.pid !== "-";
      return {
        name: s.name,
        ok: running || (s.ticks && r?.status === "0"),
        running,
        status: r?.status ?? "not loaded",
      };
    }),
  };
}

/** The Mac's sleeps since `now` less a day, from the power log. */
export async function sleeps(now: number) {
  const out = await exec(["pmset", "-g", "log"], { timeout: 20_000 });
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
