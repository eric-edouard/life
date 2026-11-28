import { join } from "node:path";
import { clock, daysBefore, MIN } from "../core/clock";
import { readJson, writeJson } from "../core/files";
import type { Engine } from "../core/names";
import { type Quota, quota } from "../models/llm";
import { OUT } from "./memory-files";
import { localTime, type Window } from "./zones";

// The nightly's schedule: launchd starts it every 30 minutes, and this decides whether a start does anything (what
// runs, the backup's turn, the night's state).

/** The night's first hour, by the Mac's clock: late enough that a night out is over and read whole (his decision, 11 Nov 2026; 02:00 before). */
export const FIRST_HOUR = 5;
/** From this hour a daily job no longer waits for the night: past the night's three tries, a tick apart. */
export const AFTER_NIGHT_HOUR = FIRST_HOUR + 4;
export const MAX_ATTEMPTS = 3;
/** Whether `used` failed tries leave none: every scheduled job's one rule. */
export const isOutOfTries = (used: number) => used >= MAX_ATTEMPTS;
/** A scheduled job's day: its tries and how the last went (`nightly`, `backup`, `bridges`). */
export interface JobState {
  attempts: number;
  date: string;
  lastAt: string;
  /** When the last successful night ended: what the next report counts from. */
  okAt?: string;
  status: "ok" | "failed";
}

/** Run, or skip silently: too early, today already ok, or three failures already (the failure email went). */
export function decide(
  hour: number,
  day: string,
  state: JobState | undefined
): "run" | "skip" {
  if (hour < FIRST_HOUR) {
    return "skip";
  }
  if (state?.date !== day) {
    return "run";
  }
  return state.status === "ok" || isOutOfTries(state.attempts) ? "skip" : "run";
}

/** A daily job's turn (the backup, the bridges' restart): once the night is done for the day (ok or out of tries) or
 * from 09:00 (`AFTER_NIGHT_HOUR`: a night stuck or never recorded must not cost the day's job), then `decide`'s rule on the job's own state. */
export const afterNightDue = (
  hour: number,
  day: string,
  night: JobState | undefined,
  job: JobState | undefined
) =>
  (decide(hour, day, night) === "skip" || hour >= AFTER_NIGHT_HOUR) &&
  decide(hour, day, job) === "run";

/**
 * Above this share of his Codex plan, the runs that can wait do (imports, evals), so the night keeps
 * the rest: a re-read night takes about 12 to 14% of a week (the 21 Oct review, gap 6).
 */
const RESERVE = 75;

/** True while `q` is over the reserve, until its window resets; an unread quota holds nothing. */
export const reserved = (
  q: Partial<Quota> | undefined,
  now = clock().getTime()
) =>
  (q?.used ?? 0) > RESERVE && !(q?.resetsAt && Date.parse(q.resetsAt) <= now);

/** The nightly email's line on the quota. */
export const quotaLine = (q: Quota | undefined, now = clock().getTime()) =>
  `Codex quota: ${q ? `${q.used}% used${q.resetsAt ? `, resets ${localTime(q.resetsAt)}` : ""}` : "not read"}${reserved(q, now) ? `: over ${RESERVE}%, imports and evals wait` : ""}`;

/** An eval or a bench run starts only under the reserve (his decision 12, 21 Oct: evals right after a reset). */
export async function spareQuota(engine?: Engine) {
  const q = await quota(engine);
  if (reserved(q)) {
    throw new Error(quotaLine(q));
  }
}

/** launchd's tick: a window opens at `earliest` and a run is expected by `latest`, if the Mac is awake and the lock is free. */
const TICK_MS = 30 * MIN;
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
export function nextNight(now: Date, day: string, state: JobState | undefined) {
  if (now.getHours() < FIRST_HOUR) {
    return windowAt(
      at(now, 0, FIRST_HOUR),
      `waits for ${String(FIRST_HOUR).padStart(2, "0")}:00`
    );
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

/** The seven days from `from`, the last cut at `last`. */
export function weekFrom(from: string, last: string): Window {
  const end = daysBefore(from, -6);
  return { from, to: end < last ? end : last };
}

/** The weeks from `since` to `today`, oldest first (`weekFrom`): what a step reads when it spans more than one. */
export function weeksFrom(since: string, today: string) {
  const weeks: Window[] = [];
  for (let from = since; from <= today; from = daysBefore(from, -7)) {
    weeks.push(weekFrom(from, today));
  }
  return weeks;
}

/** A scheduled job's state (`nightly`, `backup`, `bridges`). */
type Job = "nightly" | "backup" | "bridges";
const stateFile = (job: Job) => join(OUT, `${job}.json`);
export const readState = (job: Job = "nightly") =>
  readJson<JobState>(stateFile(job));

/** Records the outcome of a night (or of a `job`'s run); a new day starts at zero attempts. */
export function recordState(day: string, ok: boolean, job: Job = "nightly") {
  const prev = readState(job);
  const attempts = prev?.date === day ? prev.attempts : 0;
  const state: JobState = {
    attempts: ok ? attempts : attempts + 1,
    date: day,
    lastAt: clock().toISOString(),
    okAt: ok ? clock().toISOString() : prev?.okAt,
    status: ok ? "ok" : "failed",
  };
  writeJson(stateFile(job), state);
  return state;
}
