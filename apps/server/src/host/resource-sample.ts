import { log } from "../core/log";
import { TEST } from "../core/paths";
import { WINDOWS } from "../core/platform";
import { exec } from "../core/proc";
import { NETWORKS } from "../sources/networks";

// What loads the Mac, once a minute: one `resource.sample` line (the watcher's minute, his own Life only). Per group
// of Life's processes, CPU % and RSS; the system's load, memory, swap, disk, battery and heat. Metadata only.

interface Proc {
  cmd: string;
  cpu: number;
  pid: number;
  ppid: number;
  rssKb: number;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/;
/** `ps -Eaxww -o pid=,ppid=,pcpu=,rss=,command=`'s lines: each process's arguments, then its environment. */
export const parsePs = (out: string): Proc[] =>
  out.split("\n").flatMap((line) => {
    const m = line.match(PS_LINE);
    return m
      ? [
          {
            cmd: m[5] ?? "",
            cpu: Number(m[3]),
            pid: Number(m[1]),
            ppid: Number(m[2]),
            rssKb: Number(m[4]),
          },
        ]
      : [];
  });

// A process is known by the program it runs, at the start of its command line: an absolute path of whole folders,
// where only the folders Life's programs live in hold a space ("Application Support", "Lifelog Host…"), so a
// program that only names one of Life's in its arguments (`grep build/Life.app/…`) is never taken for it.
const AT = "^(?:/(?:Application Support|Lifelog Host[^/ ]*|[^/ ]+))*";
/** The helper commands Life.app keeps running (`Supervisor.swift`), and the CLI's from a checkout; any other is `life.other`. */
const COMMANDS = new Set(["archive", "desk", "memory", "watch"]);
const commandOf = (m: RegExpMatchArray) =>
  `life.${COMMANDS.has(m[1] ?? "") ? m[1] : "other"}`;
/** Which of Life's groups a process is, first rule first; each names a fixed group. */
const RULES: [RegExp, (m: RegExpMatchArray) => string | undefined][] = [
  [new RegExp(`${AT}/llama-server .*--embedding`), () => "embedder"],
  [new RegExp(`${AT}/llama-server `), () => "describer"],
  [new RegExp(`${AT}/Life\\.app/Contents/Helpers/life (\\S+)`), commandOf],
  [
    new RegExp(`${AT}/Life\\.app/Contents/Helpers/life-foundation-model\\b`),
    () => "foundation",
  ],
  [new RegExp(`${AT}/Life\\.app/Contents/`), () => "life.app"],
  [/^\S*bun \S*\/life-entry\.ts (\S+)/, commandOf],
  [
    new RegExp(
      `${AT}/Lifelog Host\\.app/Contents/Helpers/(lifelog-server|lifelog-quiet|cloudflared)\\b`
    ),
    (m) => `voice.${m[1]}`,
  ],
  [new RegExp(`${AT}/identity/venv/bin/python3? `), () => "voice.identity"],
  [new RegExp(`${AT}/Lifelog Host\\.app/Contents/`), () => "voice.host"],
  [/^\.venv\/bin\/python -m synapse\.app\.homeserver /, () => "homeserver"],
];
/** A bridge, run as `./bridge` in its folder, named at launch (`LIFE_BRIDGE`, `RUN_BRIDGES`). */
const BRIDGE = /^\.\/bridge -c config\.yaml .*\bLIFE_BRIDGE=([a-z]+)\b/;
const BRIDGES = new Set<string>(NETWORKS.map((n) => n.name));
/** A desk agent's runtime and its tools (`LIFE_DESK_AGENT`, set at spawn, inherited): taken only under the desk. */
const AGENT = /\bLIFE_DESK_AGENT=(agt_[0-9a-f]{12})\b/;

const ruleOf = (cmd: string) => {
  const bridge = cmd.match(BRIDGE)?.[1];
  if (bridge && BRIDGES.has(bridge)) {
    return `bridge.${bridge}`;
  }
  for (const [re, name] of RULES) {
    const m = cmd.match(re);
    if (m) {
      return name(m);
    }
  }
};

/**
 * CPU % and RSS (MB) summed per group: a process counts under the nearest of itself and its ancestors that a rule
 * names, so a helper's children add to it; the desk's child tagged with an agent, and all under it, count as that agent.
 */
export function groupsOf(procs: Proc[]) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const named = new Map<number, string | undefined>();
  const groupOf = (pid: number, depth = 0): string | undefined => {
    if (named.has(pid)) {
      return named.get(pid);
    }
    const p = byPid.get(pid);
    const above =
      p && p.ppid > 1 && depth < 64 ? groupOf(p.ppid, depth + 1) : undefined;
    // An agent's runtime is the desk's child that names it; everything under it is that agent's, whatever it says.
    const agent = above === "life.desk" && p?.cmd.match(AGENT)?.[1];
    const group = above?.startsWith("agent.")
      ? above
      : ((agent ? `agent.${agent}` : undefined) ??
        (p && ruleOf(p.cmd)) ??
        above);
    named.set(pid, group);
    return group;
  };
  const sums: Record<string, [number, number]> = {};
  for (const p of procs) {
    const g = groupOf(p.pid);
    if (g) {
      const [cpu, rss] = sums[g] ?? [0, 0];
      sums[g] = [cpu + p.cpu, rss + p.rssKb / 1024];
    }
  }
  return Object.fromEntries(
    Object.entries(sums).map(([g, [cpu, rss]]) => [
      g,
      [Math.round(cpu * 10) / 10, Math.round(rss)],
    ])
  );
}

const LOAD = /([\d.]+)\s+([\d.]+)\s+([\d.]+)/;
const FREE = /free percentage:\s*(\d+)%/;
const SWAP_USED = /used = ([\d.]+)M/;
const SPACES = /\s+/;
const BATTERY = /(\d+)%/;
const ON_AC = /AC Power/;
const POWER: Record<string, string> = { false: "battery", true: "ac" };
const THERMAL_WARNING = /warning level[^\n]*?(\d+)/i;

/** Free disk in GB from `df -k /`'s output, or null when it failed. */
export const diskFreeGbOf = (df: string | null) => {
  const kb = Number(df?.trim().split("\n").at(-1)?.split(SPACES)[3]);
  return Number.isNaN(kb) ? null : Math.round((kb * 1024) / 1e9);
};

const numberOf = (text: string | null, re: RegExp) => {
  const m = text?.match(re)?.[1];
  return m === undefined ? null : Number(m);
};

/** The system's side of a sample, from its tools' outputs (pure); a tool that failed (null) gives null, never a 0. */
export function systemOf(o: {
  batt: string | null;
  df: string | null;
  load: string | null;
  pressure: string | null;
  swap: string | null;
  therm: string | null;
}) {
  const swap = numberOf(o.swap, SWAP_USED);
  const warning = numberOf(o.therm, THERMAL_WARNING);
  return {
    battery: numberOf(o.batt, BATTERY),
    diskFreeGb: diskFreeGbOf(o.df),
    load: o.load?.match(LOAD)?.slice(1, 4).map(Number) ?? null,
    memFree: numberOf(o.pressure, FREE),
    power: o.batt === null ? null : POWER[String(ON_AC.test(o.batt))],
    swapMb: swap === null ? null : Math.round(swap),
    thermal:
      o.therm === null ? null : `${warning ? `warning ${warning}` : "nominal"}`,
  };
}

/** A tool's output, or null when it failed. */
const read = (cmd: string[]) =>
  exec(cmd, { timeout: 20_000 }).then((r) => (r.code === 0 ? r.stdout : null));

let isSampling = false;
/** One `resource.sample` line (a Mac's tools); a sample still running skips this one. A test run reads none. */
export async function sampleResources() {
  if (TEST || WINDOWS || isSampling) {
    return;
  }
  isSampling = true;
  try {
    const [ps, load, pressure, swap, df, batt, therm] = await Promise.all([
      read(["ps", "-Eaxww", "-o", "pid=,ppid=,pcpu=,rss=,command="]),
      read(["sysctl", "-n", "vm.loadavg"]),
      read(["memory_pressure", "-Q"]),
      read(["sysctl", "-n", "vm.swapusage"]),
      read(["df", "-k", "/"]),
      read(["pmset", "-g", "batt"]),
      read(["pmset", "-g", "therm"]),
    ]);
    log("resource.sample", {
      procs: ps === null ? null : groupsOf(parsePs(ps)),
      ...systemOf({ batt, df, load, pressure, swap, therm }),
    });
  } finally {
    isSampling = false;
  }
}
