// One step of `bun run check`, under a wall-clock limit: a step that never ends (a test spinning in a synchronous loop,
// which bun's `--timeout` cannot stop) would hold the machine-wide check lock and every push behind it (28 Nov).
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import process from "node:process";

/** The exit code of a step killed at its limit (coreutils' `timeout`). */
export const TIMED_OUT = 124;
// pid, parent, group, CPU share and executable, as the `ps` below prints them.
const PROCESS = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)/;

/**
 * Every process, by executable name only: an argument can hold his data (scrub's pattern of names), and the report is
 * printed and logged. None when `ps` cannot run.
 */
function readProcesses() {
  let table = "";
  try {
    table = Bun.spawnSync([
      "ps",
      "-Ao",
      "pid=,ppid=,pgid=,%cpu=,comm=",
    ]).stdout.toString();
  } catch {
    // A sandbox can refuse it; the step's group is still killed.
  }
  return table.split("\n").flatMap((line) => {
    const m = line.match(PROCESS);
    return m
      ? [
          {
            cpu: Number(m[4]),
            group: Number(m[3]),
            name: basename(m[5] ?? ""),
            parent: Number(m[2]),
            pid: Number(m[1]),
          },
        ]
      : [];
  });
}

/**
 * Kills the step's process group `group` and every descendant of its members (each `bun test` worker leads a group of
 * its own, so the step's group alone misses them), and returns what they were, busiest first.
 */
function killTree(group: number, signal: NodeJS.Signals) {
  const rows = readProcesses();
  const tree = new Set(rows.filter((r) => r.group === group).map((r) => r.pid));
  // A set's iteration reaches what is added during it: children, then theirs.
  for (const pid of tree) {
    for (const row of rows) {
      if (row.parent === pid) {
        tree.add(row.pid);
      }
    }
  }
  // The group first, by its id: it needs no `ps`.
  for (const pid of [-group, ...tree]) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
  return rows.filter((r) => tree.has(r.pid)).sort((a, b) => b.cpu - a.cpu);
}

/** The test file a `bun test` process noted it was running (`note-test-file.ts`). */
function readTestFile(dir: string, pid: number) {
  try {
    return ` running ${readFileSync(`${dir}/${pid}`, "utf8")}`;
  } catch {
    return "";
  }
}

/**
 * Starts `cmd` in its own process group. `result` is its exit code and output once it ends; past `limitMs` it is killed
 * and `result` is `TIMED_OUT`, the output ending with what was still running. `testFiles` is the folder its test
 * processes note their file in.
 */
export function startStep(cmd: string[], limitMs: number, testFiles: string) {
  const proc = Bun.spawn(cmd, {
    detached: true,
    env: { ...process.env, LIFE_CHECK_TEST_FILES: testFiles },
    stderr: "pipe",
    stdout: "pipe",
  });
  // Drained while the step runs, so a chatty step never blocks on a full pipe, and kept for one that never ends.
  const parts = [proc.stdout, proc.stderr].map((stream) => {
    const part = { text: "" };
    const decoder = new TextDecoder();
    const drained = (async () => {
      for await (const chunk of stream) {
        part.text += decoder.decode(chunk, { stream: true });
      }
    })();
    return { drained, part };
  });
  const output = () => parts.map((p) => p.part.text).join("");
  // A step that ended is left alone: its pid may be another process's by now.
  let isOver = false;
  const kill = (signal: NodeJS.Signals = "SIGTERM") =>
    isOver ? [] : killTree(proc.pid, signal);
  let timer: Timer | undefined;
  const stuck = new Promise<{ code: number; output: string }>((resolve) => {
    timer = setTimeout(() => {
      const running = kill("SIGKILL").map(
        (r) =>
          `  ${r.pid} ${r.cpu}% CPU${readTestFile(testFiles, r.pid)}: ${r.name}`
      );
      resolve({
        code: TIMED_OUT,
        output: `${output()}\nstuck: killed after ${limitMs / 1000} s, still running:\n${running.slice(0, 12).join("\n")}`,
      });
    }, limitMs);
  });
  // The output's end is under the limit too: a process the step left behind can hold its pipe open for good.
  const ended = Promise.all([proc.exited, ...parts.map((p) => p.drained)]).then(
    ([code]) => ({ code, output: output() })
  );
  const result = Promise.race([ended, stuck]).finally(() => {
    isOver = true;
    clearTimeout(timer);
  });
  return { kill, result };
}
