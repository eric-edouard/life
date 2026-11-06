import { join } from "node:path";
import { clock, MIN } from "../core/clock";
import { readJson, writeJson } from "../core/files";
import type { Engine } from "../core/names";
import { type Quota, quota } from "../models/llm";
import { OUT } from "./ledger";
import { daysBefore, localTime, type Window } from "./units";

// The nightly's schedule: launchd starts it every 30 minutes, and this decides whether a start does anything (what
// runs, the backup's turn, the midday slot, the night's state).

const FIRST_HOUR = 2;
export const MAX_ATTEMPTS = 3;
/** Whether `used` failed tries leave none: the night's and a backfill week's one rule. */
export const isOutOfTries = (used: number) => used >= MAX_ATTEMPTS;
/** A scheduled job's day: its tries and how the last went (`nightly`, `backup`, `bridges`). */
export interface JobState {
  attempts: number;
  date: string;
  lastAt: string;
  /** When the last successful night ended: what the next report counts from (the episodes of midday runs in between included). */
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
 * from 06:00 (a night stuck or never recorded must not cost the day's job), then `decide`'s rule on the job's own state. */
export const afterNightDue = (
  hour: number,
  day: string,
  night: JobState | undefined,
  job: JobState | undefined
) =>
  (decide(hour, day, night) === "skip" || hour >= 6) &&
  decide(hour, day, job) === "run";

/**
 * Above this share of his Codex plan, the runs that can wait do (middays, backfill weeks, evals), so the night keeps
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
  `Codex quota: ${q ? `${q.used}% used${q.resetsAt ? `, resets ${localTime(q.resetsAt)}` : ""}` : "not read"}${reserved(q, now) ? `: over ${RESERVE}%, the middays, backfill and evals wait` : ""}`;

/** An eval or a bench run starts only under the reserve (his decision 12, 21 Oct: evals right after a reset). */
export async function spareQuota(engine?: Engine) {
  const q = await quota(engine);
  if (reserved(q)) {
    throw new Error(quotaLine(q));
  }
}

/** The hours of the midday runs (episodes of the day so far; no commit, no email). */
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

/**
 * When the next midday run may start. It runs only on ticks where the nightly does not, and a spent slot is not a
 * success. Over the reserve (`q`, the last reading), it waits for the quota's reset.
 */
export function nextMidday(
  now: Date,
  last: string | undefined,
  q?: Partial<Quota>
): ReturnType<typeof windowAt> {
  if (q && reserved(q, now.getTime())) {
    // With no reset time, the next tick reads it again.
    const after = new Date(q.resetsAt ?? now.getTime() + TICK_MS);
    return {
      ...nextMidday(after, last),
      why: `held: Codex quota ${q.used}% used, over ${RESERVE}%`,
    };
  }
  if (middayDue(now, last)) {
    return windowAt(now, "a slot is open: the next tick runs it");
  }
  const hour = MIDDAYS.find((h) => now.getHours() < h);
  return windowAt(
    hour === undefined ? at(now, 1, MIDDAYS[0] as number) : at(now, 0, hour),
    "the next slot"
  );
}

/**
 * The backfill's range (`bun life memory backfill`): the next local day to read, the last one, how many times its week
 * failed, and how many weeks `day` read.
 */
export interface Backfill {
  day?: string;
  failures: number;
  next: string;
  to: string;
  weeks?: number;
}
const BACKFILL = join(OUT, "backfill.json");
export const readBackfill = () => readJson<Backfill>(BACKFILL);
export function recordBackfill(b: Backfill) {
  writeJson(BACKFILL, b);
}

/** Weeks a day reads at most: about an hour of deep calls each, so his subscriptions keep room for him. */
const WEEKS_A_DAY = 4;

/**
 * The week a backfill reads next on `day`: seven days from `next`, never past `to`; none before `day`'s own night
 * went through (`night`: a week never pushes the night back), once it is done, stopped after MAX_ATTEMPTS failures of
 * one week, or `day` read its WEEKS_A_DAY.
 */
export function backfillWeek(
  b: Backfill | undefined,
  day: string,
  night: JobState | undefined
): Window | null {
  if (
    !b ||
    night?.date !== day ||
    night.status !== "ok" ||
    b.next > b.to ||
    isOutOfTries(b.failures) ||
    (b.day === day && (b.weeks ?? 0) >= WEEKS_A_DAY)
  ) {
    return null;
  }
  const end = daysBefore(b.next, -6);
  return { from: b.next, to: end < b.to ? end : b.to };
}

/** The range after `week` was read on `day`: moved past it when it went through, one more failure when it did not. */
export function afterWeek(
  b: Backfill,
  week: Window,
  ok: boolean,
  day: string
): Backfill {
  const weeks = (b.day === day ? (b.weeks ?? 0) : 0) + 1;
  return ok
    ? { day, failures: 0, next: daysBefore(week.to, -1), to: b.to, weeks }
    : { ...b, day, failures: b.failures + 1, weeks };
}

/**
 * What a 30-minute tick runs: the night when it is due; else nothing over the quota's reserve (`reserved`); else the
 * midday run when its slot is open; else a backfill week when one is due (`backfillWeek`), unless the day's backup
 * still is (it runs after the tick's work, and goes first). The backup itself is `afterNightDue`'s, after any of these.
 */
export function turnOf(
  now: Date,
  day: string,
  s: {
    backfill?: Backfill;
    backup?: JobState;
    midday?: string;
    night?: JobState;
    quota?: Quota;
  }
): "night" | "midday" | "backfill" | "none" {
  const hour = now.getHours();
  if (decide(hour, day, s.night) === "run") {
    return "night";
  }
  if (reserved(s.quota, now.getTime())) {
    return "none";
  }
  if (middayDue(now, s.midday)) {
    return "midday";
  }
  return !afterNightDue(hour, day, s.night, s.backup) &&
    backfillWeek(s.backfill, day, s.night)
    ? "backfill"
    : "none";
}

/** A scheduled job's state (`nightly`, `backup`, `bridges`). */
type Job = "nightly" | "backup" | "bridges";
const stateFile = (job: Job) => join(OUT, `${job}.json`);
const MIDDAY = join(OUT, "midday.json");
export const readState = (job: Job = "nightly") =>
  readJson<JobState>(stateFile(job));
export const readMidday = () => readJson<string>(MIDDAY);

/** Marks a midday slot as used, failed or not: a failed run waits for the next slot, the nightly reports. */
export function recordMidday() {
  writeJson(MIDDAY, clock().toISOString());
}

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
