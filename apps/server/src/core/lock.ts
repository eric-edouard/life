import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import { clock, MIN } from "./clock";
import { LIFE_STATE_DIR, real } from "./paths";
import { MACHINE_DIR } from "./platform";

// Lock files: one process holds each, its pid on the first line and a note after. Memory's lock (`locked`, memory-lock.ts)
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
    // ponytail: the lock's real mtime and boot time against the clock.
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

type Service = "archive" | "watch" | "check" | "desk";
/** A service's lock: one per Mac, so two installs never run the same service at once (two archivers, two watchers, two
 * desks, two `bun run check`s, whose tests time out when several load the Mac). */
const serviceLock = (name: Service) => join(MACHINE_DIR, `${name}.lock`);

/** Who runs a service now: its pid, since when, and the state dir it runs on as its note; null when none does. */
export const holder = (name: Service) => held(serviceLock(name));

/** Whether the service holder `live` is another install's than the one whose state dir is `state`. */
export const isOtherLife = (
  live: { note: string } | null,
  state: string = LIFE_STATE_DIR
) => live !== null && real(live.note) !== real(state);

/**
 * Waits until this process runs `name` on this Mac (while another install's copy runs, it says so once and checks
 * each minute), and keeps it until it exits; a crash or a SIGTERM leaves a stale lock the next start clears.
 */
export async function hold(name: Service, note = LIFE_STATE_DIR, every = MIN) {
  const path = serviceLock(name);
  mkdirSync(dirname(path), { recursive: true });
  await waitToTake(path, note, every, () =>
    console.log(
      `${clock().toISOString()} ${name}: another runs it (${holder(name)?.note}), waiting`
    )
  );
  process.on("exit", () => release(name));
}

/** Takes the lock file `path` once it is free, trying each `every` ms; `waiting` runs once, on the first wait. */
async function waitToTake(
  path: string,
  note: string | undefined,
  every: number,
  waiting?: () => void
) {
  if (take(path, note)) {
    return;
  }
  waiting?.();
  do {
    // biome-ignore lint/performance/noAwaitInLoops: one try each `every`
    await Bun.sleep(every);
  } while (!take(path, note));
}

/** Lets go of `name` if this process holds it: before its exit, when what needed it is done. */
export function release(name: Service) {
  if (holder(name)?.pid === String(process.pid)) {
    rmSync(serviceLock(name), { force: true });
  }
}

/**
 * One chain within this process: each call's `run` starts once the one before it ended, a failure included, so the
 * calls sharing it never overlap. Each resource keeps its own (`const inTurn = oneAtATime()`); across processes,
 * `oneAtATimeAcross`.
 */
export function oneAtATime() {
  let turn: Promise<void> = Promise.resolve();
  return <T>(run: () => Promise<T>) => {
    const next = turn.then(run);
    // The tail keeps no result: an idle chain holds nothing its last call returned.
    turn = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };
}

/**
 * `oneAtATime` across processes too: each call also holds the lock file `path` (waited for, never refused; a dead
 * holder's cleared by `take`), so calls from every process sharing `path` never overlap.
 */
export function oneAtATimeAcross(path: string, every = 100) {
  const inTurn = oneAtATime();
  mkdirSync(dirname(path), { recursive: true });
  return <T>(run: () => Promise<T>) =>
    inTurn(async () => {
      await waitToTake(path, undefined, every);
      try {
        return await run();
      } finally {
        rmSync(path, { force: true });
      }
    });
}
