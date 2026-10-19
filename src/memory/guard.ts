import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { DATA } from "../truth";
import { OUT, readJson } from "./ledger";

// launchd starts the nightly every 30 minutes; this guard decides whether a start does anything.

const FIRST_HOUR = 2;
export const MAX_ATTEMPTS = 3;
export interface NightState {
  attempts: number;
  date: string;
  lastAt: string;
  /** When the last successful night ended: what the next report counts from (midday runs in between included). */
  okAt?: string;
  status: "ok" | "failed";
}

/** Run, or skip silently: too early, today already ok, or three failures already (the failure email went). */
export function decide(
  hour: number,
  day: string,
  state: NightState | undefined
): "run" | "skip" {
  if (hour < FIRST_HOUR) {
    return "skip";
  }
  if (state?.date !== day) {
    return "run";
  }
  return state.status === "ok" || state.attempts >= MAX_ATTEMPTS
    ? "skip"
    : "run";
}

/** The backup's turn on a tick: once the night is done for the day (ok or out of tries) or from 06:00 (a night stuck or
 * never recorded must not cost the day's backup), then `decide`'s rule on its own state. */
export const backupDue = (
  hour: number,
  day: string,
  night: NightState | undefined,
  backup: NightState | undefined
) =>
  (decide(hour, day, night) === "skip" || hour >= 6) &&
  decide(hour, day, backup) === "run";

/** The hours of the midday runs (moments and extract of the day so far, no pages, no commit, no email). */
const MIDDAYS = [13, 19];

/** True at the first tick after a midday hour that no run has used yet (`last`: when the last midday run started). */
export function middayDue(now: Date, last: string | undefined) {
  const hour = MIDDAYS.findLast((h) => now.getHours() >= h);
  if (hour === undefined) {
    return false;
  }
  const slot = new Date(now);
  slot.setHours(hour, 0, 0, 0);
  return !last || Date.parse(last) < slot.getTime();
}

/** launchd's tick: a window opens at `earliest` and a run is expected by `latest`, if the Mac is awake and the lock is free. */
const TICK_MS = 30 * 60_000;
const windowAt = (earliest: Date, why: string) => ({
  earliest: earliest.toISOString(),
  latest: new Date(earliest.getTime() + TICK_MS).toISOString(),
  why,
});
const at = (from: Date, plusDays: number, hour: number) => {
  const d = new Date(from);
  d.setDate(d.getDate() + plusDays);
  d.setHours(hour, 0, 0, 0);
  return d;
};

/** When the next nightly may start, and why then (`decide`'s rules, read forward). */
export function nextNight(
  now: Date,
  day: string,
  state: NightState | undefined
) {
  if (now.getHours() < FIRST_HOUR) {
    return windowAt(at(now, 0, FIRST_HOUR), "waits for 02:00");
  }
  if (decide(now.getHours(), day, state) === "run") {
    return windowAt(
      now,
      state?.date === day
        ? `retry ${state.attempts + 1} of ${MAX_ATTEMPTS} after a failure`
        : "today's night has not run yet"
    );
  }
  return windowAt(
    at(now, 1, FIRST_HOUR),
    state?.status === "ok"
      ? "today's night succeeded"
      : `${MAX_ATTEMPTS} failures today: no more tries until tomorrow`
  );
}

/** When the next midday run may start. It runs only on ticks where the nightly does not, and a spent slot is not a success. */
export function nextMidday(now: Date, last: string | undefined) {
  if (middayDue(now, last)) {
    return windowAt(now, "a slot is open: the next tick runs it");
  }
  const hour = MIDDAYS.find((h) => now.getHours() < h);
  return windowAt(
    hour === undefined ? at(now, 1, MIDDAYS[0] as number) : at(now, 0, hour),
    "the next slot"
  );
}

/** A scheduled job's state (`nightly`, `backup`). */
type Job = "nightly" | "backup";
const stateFile = (job: Job) => join(OUT, `${job}.json`);
const MIDDAY = join(OUT, "midday.json");
/** In the data repo, not in derived/: every worktree shares one lock with production. */
export const LOCK = join(DATA, ".nightly.lock");

export const readState = (job: Job = "nightly") =>
  readJson<NightState>(stateFile(job));
export const readMidday = () => readJson<string>(MIDDAY);

/** Marks a midday slot as used, failed or not: a failed run waits for the next slot, the nightly reports. */
export function recordMidday() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(MIDDAY, JSON.stringify(new Date().toISOString()));
}

/** Records the outcome of a night (or of a `job`'s run); a new day starts at zero attempts. */
export function recordState(day: string, ok: boolean, job: Job = "nightly") {
  const prev = readState(job);
  const attempts = prev?.date === day ? prev.attempts : 0;
  const state: NightState = {
    attempts: ok ? attempts : attempts + 1,
    date: day,
    lastAt: new Date().toISOString(),
    okAt: ok ? new Date().toISOString() : prev?.okAt,
    status: ok ? "ok" : "failed",
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(stateFile(job), `${JSON.stringify(state)}\n`);
  return state;
}

/** When the run holding the lock took it, or null when none holds it (its pid is dead, or it predates the boot: a pid is reused). */
export function lockedSince(): Date | null {
  try {
    const since = statSync(LOCK).mtime;
    process.kill(Number(readFileSync(LOCK, "utf8")), 0);
    return since.getTime() >= Date.now() - uptime() * 1000 ? since : null;
  } catch {
    return null; // no lock, or a stale pid
  }
}

/** True while a run holds the lock: the watcher then leaves memory/ and the index alone. */
export const isLocked = () => lockedSince() !== null;

/** Creates the lock file, atomically ("wx"): a stale one (see `lockedSince`) is cleared and the lock taken once more. */
function take(retry = true): boolean {
  try {
    writeFileSync(LOCK, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    if (!retry || isLocked()) {
      return false;
    }
    rmSync(LOCK, { force: true });
    return take(false);
  }
}

/** Runs `run` holding the lock, so nothing else writes memory/ meanwhile; `null`, without running, when a run holds it. */
export async function locked<T>(run: () => Promise<T>) {
  mkdirSync(OUT, { recursive: true });
  if (!take()) {
    console.error("another run is still going");
    return null;
  }
  try {
    return await run();
  } finally {
    rmSync(LOCK, { force: true });
  }
}
