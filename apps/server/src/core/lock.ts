import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import { clock } from "./clock";
import { real, STATE } from "./paths";
import { MACHINE } from "./platform";

// Lock files: one process holds each, its pid on the first line and a note after. Memory's lock (`locked`, guard.ts)
// and the services' (`hold`): one Life per Mac.

/**
 * Who holds the lock file `path`: its pid, since when and its note; null when none does (no file, a dead pid, or a
 * lock from before the boot: pids are reused).
 */
export function held(path: string) {
  try {
    const since = statSync(path).mtime;
    const [pid = "", note = ""] = readFileSync(path, "utf8").split("\n");
    process.kill(Number(pid), 0);
    // ponytail: the lock's real mtime and boot time against the clock; a frozen run (the bench) never takes a lock.
    return since.getTime() >= clock().getTime() - uptime() * 1000
      ? { note, pid, since }
      : null;
  } catch {
    return null;
  }
}

/**
 * Creates the lock file `path` for this process, atomically ("wx"): a stale one (see `held`) is cleared and the lock
 * taken once more. ponytail: two starts that find the same stale lock can each clear it and both believe they took it
 * (a window of microseconds); checking the holder's start time against the lock's would close it.
 */
export function take(path: string, note?: string, retry = true): boolean {
  try {
    writeFileSync(path, [process.pid, note].join("\n"), { flag: "wx" });
    return true;
  } catch {
    if (!retry || held(path)) {
      return false;
    }
    rmSync(path, { force: true });
    return take(path, note, false);
  }
}

type Service = "archive" | "watch";
/** A service's lock: one per Mac, so two installs never run the same service at once (two archivers, two watchers). */
const serviceLock = (name: Service) => join(MACHINE, `${name}.lock`);

/** Who runs a service now: its pid, since when, and the state root it runs on as its note; null when none does. */
export const holder = (name: Service) => held(serviceLock(name));

/** Whether the service holder `live` is another install's than the one whose state root is `state`. */
export const isOtherLife = (
  live: { note: string } | null,
  state: string = STATE
) => live !== null && real(live.note) !== real(state);

/**
 * Waits until this process runs `name` on this Mac (while another install's copy runs, it says so once and checks
 * each minute), and keeps it until it exits; a crash or a SIGTERM leaves a stale lock the next start clears.
 */
export async function hold(name: Service) {
  const path = serviceLock(name);
  mkdirSync(dirname(path), { recursive: true });
  let said = false;
  while (!take(path, STATE)) {
    if (!said) {
      console.log(
        `${clock().toISOString()} ${name}: another Life runs it (${holder(name)?.note}), waiting`
      );
      said = true;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one check a minute
    await Bun.sleep(60_000);
  }
  process.on("exit", () => {
    if (holder(name)?.pid === String(process.pid)) {
      rmSync(path, { force: true });
    }
  });
}
