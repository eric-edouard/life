import { DAY } from "../../core/clock";
import { holder } from "../../core/lock";
import { TEST } from "../../core/paths";
import { exec } from "../../core/proc";

// The Mac Life runs on, as the status snapshot shows it (apps/server/src/host/status/snapshot.ts): awake since, battery, disk, the archive and the
// watcher, and its sleeps of the last day. Read-only.

const WAKE_SEC = /sec = (\d+)/;
const SPACES = /\s+/;
const BATTERY = /(\d+)%;\s*([^;]+)/;
const POWER_LINE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}) (Sleep|Wake)\s/;
const ZONE_OFFSET = / ([+-]\d{2})(\d{2})$/;

/** One read of this computer; a test run reads none, as it reads its own data and never this computer's. */
const machine = (cmd: string[], o?: Parameters<typeof exec>[1]) =>
  TEST
    ? Promise.resolve({ code: 0, killed: null, stderr: "", stdout: "" })
    : exec(cmd, o);

export async function macState() {
  const [batt, disk, wake] = await Promise.all([
    machine(["pmset", "-g", "batt"]),
    machine(["df", "-k", "/"]),
    machine(["sysctl", "-n", "kern.waketime"]),
  ]);
  const sec = Number(wake.stdout.match(WAKE_SEC)?.[1] ?? 0);
  const free =
    Number(disk.stdout.trim().split("\n").at(-1)?.split(SPACES)[3] ?? 0) * 1024;
  // The archive and the watcher, whoever runs them: who holds each one's lock (`hold`, lock.ts).
  const services = (["archive", "watch"] as const).map((name) => {
    const h = holder(name);
    return {
      name,
      running: !!h,
      since: h?.since.toISOString() ?? null,
      status: h ? "running" : "nothing holds its lock",
    };
  });
  return {
    awakeSince: sec ? new Date(sec * 1000).toISOString() : null,
    battery: batt.stdout.match(BATTERY)?.slice(1, 3).join(", ") ?? "?",
    freeGb: Math.round(free / 1e9),
    services,
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
