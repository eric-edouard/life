import { DAY } from "../core/clock";
import { log } from "../core/log";
import { TEST } from "../core/paths";
import { exec } from "../core/proc";

// What loads the Mac, once a minute: one `resource.sample` line (the watcher's minute, his own Life only). Per group
// of Life's processes, CPU % and RSS; the system's load, memory, swap, disk, battery and heat. Metadata only.

export interface Proc {
  args: string;
  cpu: number;
  pid: number;
  ppid: number;
  rssKb: number;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/;
/** `ps -axo pid=,ppid=,pcpu=,rss=,args=`'s lines. */
export const parsePs = (out: string): Proc[] =>
  out.split("\n").flatMap((line) => {
    const m = line.match(PS_LINE);
    return m
      ? [
          {
            args: m[5] ?? "",
            cpu: Number(m[3]),
            pid: Number(m[1]),
            ppid: Number(m[2]),
            rssKb: Number(m[4]),
          },
        ]
      : [];
  });

/** Which of Life's groups a process is by its own arguments, first rule first; anything else is not Life's. */
const RULES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/llama-server\b.*--embedding/, () => "embedder"],
  [/llama-server\b/, () => "describer"],
  [/Helpers\/life (\S+)/, (m) => `life.${m[1]}`],
  [/life-entry\.ts (\S+)/, (m) => `life.${m[1]}`],
  [/Life\.app\/Contents\/MacOS\//, () => "life.app"],
  [/Lifelog Host\.app\/Contents\/Helpers\/(\S+)/, (m) => `voice.${m[1]}`],
  [/Lifelog Host\.app\/Contents\/MacOS\//, () => "voice.host"],
  [/foundation-model|FoundationModel/, () => "foundation"],
  [/synapse\.app\.homeserver/, () => "homeserver"],
  [/mautrix-(\w+)/, (m) => `bridge.${m[1]}`],
];
const ruleOf = (args: string) => {
  for (const [re, name] of RULES) {
    const m = args.match(re);
    if (m) {
      return name(m);
    }
  }
};

/**
 * CPU % and RSS (MB) summed per group: a process counts under the nearest of itself and its ancestors that a rule or
 * a desk agent (`agents`, pid to agent) names, so a helper's children add to it.
 */
export function groupsOf(procs: Proc[], agents: Map<number, string>) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const named = new Map<number, string | undefined>();
  const groupOf = (pid: number, depth = 0): string | undefined => {
    if (named.has(pid)) {
      return named.get(pid);
    }
    const p = byPid.get(pid);
    const agent = agents.get(pid);
    const own = agent ? `agent.${agent}` : p && ruleOf(p.args);
    const group =
      own ??
      (p && p.ppid > 1 && depth < 64 ? groupOf(p.ppid, depth + 1) : undefined);
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

const AGENT_ENV = /^\s*(\d+)\s.*\bLIFE_DESK_AGENT=(\S+)/;
/** The desk agents' processes by pid, from `ps -E`'s environments (`LIFE_DESK_AGENT`, set at spawn, inherited by their tools). */
export const agentPidsOf = (out: string) =>
  new Map(
    out.split("\n").flatMap((line) => {
      const m = line.match(AGENT_ENV);
      return m ? [[Number(m[1]), m[2] ?? ""] as const] : [];
    })
  );

const LOAD = /([\d.]+)\s+([\d.]+)\s+([\d.]+)/;
const FREE = /free percentage:\s*(\d+)%/;
const SWAP_USED = /used = ([\d.]+)M/;
const SPACES = /\s+/;
const BATTERY = /(\d+)%/;
const ON_AC = /AC Power/;
const THERMAL_WARNING = /warning level[^\n]*?(\d+)/i;

/** The system's side of a sample, from its tools' outputs (pure). */
export function systemOf(o: {
  batt: string;
  df: string;
  load: string;
  pressure: string;
  swap: string;
  therm: string;
}) {
  const load = o.load.match(LOAD)?.slice(1, 4).map(Number) ?? null;
  const freeKb = Number(o.df.trim().split("\n").at(-1)?.split(SPACES)[3] ?? 0);
  const battery = o.batt.match(BATTERY)?.[1];
  const warning = o.therm.match(THERMAL_WARNING)?.[1];
  return {
    battery: battery === undefined ? null : Number(battery),
    diskFreeGb: Math.round((freeKb * 1024) / 1e9),
    load,
    memFree: Number(o.pressure.match(FREE)?.[1] ?? Number.NaN) || null,
    power: ON_AC.test(o.batt) ? "ac" : "battery",
    swapMb: Math.round(Number(o.swap.match(SWAP_USED)?.[1] ?? 0)),
    thermal: warning ? `warning ${warning}` : "nominal",
  };
}

const read = (cmd: string[]) =>
  exec(cmd, { timeout: 20_000 }).then((r) => r.stdout);

let isSampling = false;
/** One `resource.sample` line; a sample still running skips this one. A test run reads none. */
export async function sampleResources() {
  if (TEST || isSampling) {
    return;
  }
  isSampling = true;
  try {
    const [ps, load, pressure, swap, df, batt, therm, envs] = await Promise.all(
      [
        read(["ps", "-axo", "pid=,ppid=,pcpu=,rss=,args="]),
        read(["sysctl", "-n", "vm.loadavg"]),
        read(["memory_pressure", "-Q"]),
        read(["sysctl", "-n", "vm.swapusage"]),
        read(["df", "-k", "/"]),
        read(["pmset", "-g", "batt"]),
        read(["pmset", "-g", "therm"]),
        read(["ps", "-Eaxo", "pid=,command="]),
      ]
    );
    log("resource.sample", {
      procs: groupsOf(parsePs(ps), agentPidsOf(envs)),
      ...systemOf({ batt, df, load, pressure, swap, therm }),
    });
  } finally {
    isSampling = false;
  }
}

/** How far back a resource read goes: the last hour, at one sample a minute. */
export const SAMPLES_BACK = DAY / 24;
