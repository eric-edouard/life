import { checks } from "../actions";
import { backup, backupLine } from "../backup";
import { readHealth } from "../health";
import { type Action, isTaskLine } from "../schema";
import { taskList } from "../tasks";
import { extract } from "./extract";
import {
  backupDue,
  decide,
  locked,
  lockedSince,
  MAX_ATTEMPTS,
  middayDue,
  readMidday,
  readState,
  recordMidday,
  recordState,
} from "./guard";
import { newSince, readActions } from "./ledger";
import { moments } from "./moments";
import { placed } from "./page";
import { pages } from "./pages";
import {
  failureReport,
  lockReport,
  type Mail,
  sendReport,
  successReport,
} from "./report";
import { codeOn, mapRepos } from "./repos";
import { commitMemory, phases, type RunRecord, record } from "./run";
import { reindex } from "./search";
import { clip, daysBefore, gather, localTime, windowStart } from "./units";
import { observationsNow, readPeople } from "./who";
import { localDate, noteZone } from "./zones";

/**
 * The default look-back of every step: yesterday, plus what a sleeping Mac or a late summary left behind, and the
 * lifelog units lifelog re-summarizes a few days later (their new hash needs a new verdict).
 */
export const DAYS = 7;
/** A run holding the lock longer than this is stuck: the nightly emails once (per lock). */
const STUCK_MS = 3 * 3_600_000;

const DAY_MS = 24 * 3_600_000;

/** The report's Actions: what Life did in the last 24 h and what stops it from acting. Never fails the night: a failure is one more problem. */
async function acted(now: Date, rec: RunRecord) {
  const problems = await checks();
  let actions: Action[] = [];
  let tasks: ReturnType<typeof taskList> = [];
  try {
    actions = readActions();
    tasks = taskList(now.getTime());
  } catch (e) {
    const { message } = e as Error;
    problems.push(`actions.jsonl: ${message}`);
    rec.error(message, { step: "memory.nightly.actions" });
  }
  // A task's own lines (Atlas's updates, nudges, steers) are its rows, not actions.
  return {
    actions: actions.filter(
      (a) => !isTaskLine(a) && Date.parse(a.at) >= now.getTime() - DAY_MS
    ),
    problems,
    tasks: tasks.map((t) => ({
      name: `${t.state} · ${t.age}`,
      relation: `${clip(t.quote, 120)} → ${t.note ?? "…"} · deadline ${t.deadline ? localTime(t.deadline) : "none"} · ${t.nudges} nudges, ${t.extensions} extensions`,
    })),
  };
}

/** Yesterday's Code rows. Never fails the night: a failure is logged and there are no rows. */
function coded(day: string, rec: RunRecord) {
  return codeOn(daysBefore(day, 1)).catch((e: Error) => {
    rec.error(e.message, { step: "memory.nightly.code" });
    return [];
  });
}

/**
 * Repo map, moments (who the unknown people are too), extract, pages, index, then one commit "Memory: <date>" and one report email. A failed
 * step stops the run with nothing committed; the next run resumes (every step caches). launchd starts it every 30
 * minutes; unless `force`, a start does nothing before 02:00, once the day is ok, or after 3 failures (guard.ts), and
 * only the 3rd failure of a day sends the failure email. A tick that skips the night runs the midday pass. Then the
 * daily backup, when it is due (`backupDue`: the night is done, on this tick or before).
 */
export async function nightly(days: number, force = false) {
  const now = new Date();
  const held = lockedSince();
  if (held && now.getTime() - held.getTime() > STUCK_MS) {
    await sendReport(
      `lock/${held.toISOString()}`,
      lockReport(held.toISOString())
    );
  }
  // Each tick is a fresh process: the place to notice he moved (only the Mac's own zone counts, never a TZ variable).
  await locked(() => noteZone(now));
  const day = localDate(now.toISOString());
  // `force` skips the day's schedule, never the lock: two nights must not write memory/ at once. A hand run never backs up.
  const code =
    !force && decide(now.getHours(), day, readState()) === "skip"
      ? await midday(now)
      : ((await locked(() => runNight(days, now, day, force))) ??
        Number(force));
  if (
    force ||
    !backupDue(now.getHours(), day, readState(), readState("backup"))
  ) {
    return code;
  }
  // Recorded even when it throws, so a day never tries more than 3 times.
  let backedUp = 1;
  try {
    backedUp = await backup();
  } finally {
    recordState(day, backedUp === 0, "backup");
  }
  return Math.max(code, backedUp);
}

/**
 * A midday run (about 13:00 and 19:00, same 30-minute tick): moments and extract of today, so the day's speech is read
 * while it is fresh, then the index. No pages, no commit, no email: the nightly commits and reports all of
 * it, from the ledger. Holds the nightly's lock; `force` (a hand run) skips the schedule, never the lock. A failure
 * is only logged, and the slot is spent.
 */
export async function midday(now = new Date(), force = false) {
  if (!(force || middayDue(now, readMidday()))) {
    return 0;
  }
  const code = await locked(async () => {
    recordMidday();
    const rec = record("memory.midday", { days: 1 });
    const phase = phases(rec);
    try {
      // The day's evidence is read once, for both steps.
      phase.at = "gather";
      const evidence = await gather(windowStart(now, 1));
      const found = await phase.step("moments", () =>
        moments({ days: 1, evidence })
      );
      console.log(JSON.stringify(found));
      const extracted = await phase.step("extract", () =>
        extract({ days: 1, evidence })
      );
      console.log(JSON.stringify(extracted));
      phase.at = "index";
      await reindex();
      rec.end({ outcome: "ok" });
      return 0;
    } catch (e) {
      rec.end(phase.failed(e));
      return 1;
    }
  });
  return code ?? Number(force);
}

/**
 * What the night found, from the ledger: the observations that show and are new since `since` (`newSince`), the
 * salience-3 page lines not retired, by their home page (`placed`), and the retirements those new observations made.
 */
async function whatIsNew(since: string) {
  const people = await readPeople();
  const { all, observations, standing } = await observationsNow(people);
  const fresh = observations.filter(newSince(all, since));
  const ids = new Set(fresh.map((o) => o.id));
  const { homes } = placed(observations, people.truth);
  return {
    facts: [...homes].flatMap(([home, lines]) =>
      lines.flatMap(({ o }) =>
        ids.has(o.id) && o.salience === 3 && !standing.retired.has(o.id)
          ? [{ id: o.id, page: people.names.get(home) ?? home, text: o.text }]
          : []
      )
    ),
    observed: fresh.length,
    retired: [...standing.retired.values()].filter(
      (s) => ids.has(s.by) && s.by !== s.observation
    ).length,
  };
}

async function runNight(days: number, now: Date, day: string, force: boolean) {
  // Recorded inside the lock (not at `now`, from before it), so a night in progress reads as running.
  const rec = record("memory.nightly", { days, force });
  // Lines first cited since the last good night (with no guard state, the window) are new in this report, midday runs' too.
  const last = readState();
  const since =
    last?.okAt ?? last?.lastAt ?? windowStart(now, days).toISOString();
  const phase = phases(rec);
  let mail: Mail;
  // The observations the report lists, in the run record: an audit can tell what he was told.
  let listed: string[] = [];
  let failure: ReturnType<typeof phase.failed> | undefined;
  try {
    const repos = await phase.step("repos", () => mapRepos());
    // Every source is read once and handed to each step.
    phase.at = "gather";
    const watcher = readHealth();
    const evidence = await gather(windowStart(now, days));
    const found = await phase.step("moments", () =>
      moments({ days, evidence })
    );
    const extracted = await phase.step("extract", () =>
      extract({ days, evidence })
    );
    const { facts, observed, retired } = await whatIsNew(since);
    const paged = await phase.step("pages", () => pages({ rebuild: false }));
    phase.at = "index";
    await reindex();
    phase.at = "actions";
    const report = await acted(now, rec);
    const commits = await coded(day, rec);
    phase.at = "commit";
    commitMemory(["memory", "truth"], `Memory: ${day}`);
    mail = successReport(day, rec.ms(), {
      acted: report,
      backup: backupLine(now),
      code: commits,
      extracted,
      facts,
      files: evidence.files,
      from: daysBefore(day, days - 1),
      moments: found,
      observed,
      paged,
      repos,
      retired,
      watcher,
    });
    listed = facts.map((f) => f.id);
  } catch (e) {
    failure = phase.failed(e);
    mail = failureReport(day, rec.ms(), failure.failedAt, failure.error);
  }
  const { attempts } = recordState(day, !failure);
  rec.end({ attempts, listed, ...(failure ?? { outcome: "ok" }) });
  if (!failure || force || attempts >= MAX_ATTEMPTS) {
    const id = await sendReport(`nightly/${rec.run}`, mail);
    console.log(id ? `report emailed: ${id}` : "report email not sent");
  }
  return failure ? 1 : 0;
}
