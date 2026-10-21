import {
  ARCHIVE_LOOKBACK,
  archiveFailing,
  keptStores,
  openIncidents,
} from "../archive";
import { backup, backupLine } from "../backup";
import { clock } from "../clock";
import { isReviewCall } from "../events";
import { readHealth } from "../health";
import { type Quota, quota } from "../llm";
import { type Call, log, recentEvents } from "../log";
import { checks } from "../reminders/remctl";
import {
  type Action,
  type Extracted,
  isListed,
  type Observation,
} from "../schema";
import { taskList, titleOf, unanswered } from "../tasks";
import { closeness, pagedNow } from "./closeness";
import { extract } from "./extract";
import {
  afterWeek,
  backfillWeek,
  backupDue,
  locked,
  lockedSince,
  MAX_ATTEMPTS,
  middayDue,
  quotaLine,
  readBackfill,
  readMidday,
  readState,
  recordBackfill,
  recordMidday,
  recordState,
  turnOf,
} from "./guard";
import { runs, useText } from "./history";
import { newSince, readActions } from "./ledger";
import { moments } from "./moments";
import { placed } from "./page";
import { pages } from "./pages";
import { syncPast } from "./past";
import {
  archiveFailedReport,
  failureReport,
  lockReport,
  type Mail,
  reportKey,
  sendReport,
  successReport,
} from "./report";
import { codeOn, mapRepos } from "./repos";
import {
  commitMemory,
  type Metered,
  metered,
  phases,
  type RunRecord,
} from "./run";
import { reindex } from "./search";
import {
  type Built,
  daysBefore,
  gather,
  lastDays,
  localTime,
  type Window,
} from "./units";
import { observationsNow, readPeople } from "./who";
import { dayStart, localDate, noteZone } from "./zones";

/** A run holding the lock longer than this is stuck: the nightly emails once (per lock). */
const STUCK_MS = 3 * 3_600_000;
const ALERT_MS = 3_600_000;

const DAY_MS = 24 * 3_600_000;

/** Whether Atlas (ChatGPT's MCP client) read `day` in the last 24 h, as its daily review does (docs/atlas.md): a review that found Life unreachable leaves no other trace. */
export const reviewed = async (now: Date) =>
  (await recentEvents<Call>(2, "mcp.call")).some(
    (e) => isReviewCall(e) && Date.parse(e.at) >= now.getTime() - DAY_MS
  );

/** The report's Actions: what Life did in the last 24 h and what stops it from acting. Never fails the night: a failure is one more problem. */
async function acted(now: Date, rec: Pick<RunRecord, "error">) {
  const problems = await checks();
  if (!(await reviewed(now))) {
    problems.push("no daily review reached Life in the last 24 h");
  }
  let actions: Action[] = [];
  let tasks: ReturnType<typeof taskList> = [];
  let gaps = 0;
  try {
    actions = readActions();
    tasks = taskList(now.getTime());
    gaps = unanswered(now.getTime() - DAY_MS);
  } catch (e) {
    const { message } = e as Error;
    problems.push(`actions.jsonl: ${message}`);
    rec.error(message, { step: "memory.nightly.actions" });
  }
  // A task's own lines (Atlas's updates) are its rows, not actions.
  return {
    actions: actions.filter(
      (a) => isListed(a) && Date.parse(a.at) >= now.getTime() - DAY_MS
    ),
    problems,
    tasks: [
      ...tasks.map((t) => ({
        name: `${t.state} · ${t.age}`,
        relation: `${titleOf(t)} → ${t.note ?? "…"} · deadline ${t.deadline ? localTime(t.deadline) : "none"}`,
      })),
      // Atlas logs its replies by the playbook, not by code: the asks it never logged one for show here.
      ...(gaps > 0
        ? [
            {
              name: "No reply logged",
              relation: `${gaps} of the last day's asks`,
            },
          ]
        : []),
    ],
  };
}

/** Yesterday's Code rows. Never fails the night: a failure is logged and there are no rows. */
function coded(day: string, rec: Pick<RunRecord, "error">) {
  return codeOn(daysBefore(day, 1)).catch((e: Error) => {
    rec.error(e.message, { step: "memory.nightly.code" });
    return [];
  });
}

/** The nightly's line on the archive: the incidents that started since `since` (an ISO instant) or are still open. */
export async function archiveLine(since: string) {
  const lines = await recentEvents(ARCHIVE_LOOKBACK);
  const still = new Set(openIncidents(lines).values());
  const kept = new Set(keptStores().map((s) => `archive.${s.name}`));
  const listed = lines
    .filter(
      (e) =>
        e.kind === "run.error" &&
        kept.has(e.step) &&
        (e.at >= since || still.has(e))
    )
    .map(
      (e) =>
        `${e.step.slice("archive.".length)} from ${localTime(e.at)}${still.has(e) ? ", still failing" : ""}: ${String(e.error)}`
    );
  return `Archive: ${listed.length > 0 ? `FAILED: ${listed.join("; ")}` : "no failure"}`;
}

/**
 * Repo map, moments (who the unknown people are too), extract, pages, index, then one commit "Memory: <date>" and one report email. A failed
 * step stops the run with nothing committed; the next run resumes (every step caches). launchd starts it every 30
 * minutes; unless `force`, a start does nothing before 02:00, once the day is ok, or after 3 failures (guard.ts), and
 * only the 3rd failure of a day sends the failure email. What a tick runs is `turnOf`'s: the night, else the midday
 * pass (moments, extract, pages) when its slot is open, else a backfill week; neither over the Codex quota's reserve
 * (`reserved`), read each tick. Then the daily backup, when it is due
 * (`backupDue`: the night is done, on this tick or before).
 */
export async function nightly(days: number, force = false) {
  const now = clock();
  const held = lockedSince();
  if (held && now.getTime() - held.getTime() > STUCK_MS) {
    await sendReport(
      `lock/${held.toISOString()}`,
      lockReport(held.toISOString())
    );
  }
  // Each store failing for an hour: one email per incident and day while it lasts (the key).
  for (const [name, e] of await archiveFailing(ALERT_MS, now.getTime())) {
    // biome-ignore lint/performance/noAwaitInLoops: rare, one store at a time
    await sendReport(
      `archive/${name}/${e.at}/${localDate(now.toISOString())}`,
      archiveFailedReport(name, e.at, String(e.error))
    );
  }
  // Each tick is a fresh process: the place to notice he moved (only the Mac's own zone counts, never a TZ variable).
  await locked(() => noteZone(now));
  const day = localDate(now.toISOString());
  // `force` skips the day's schedule, never the lock: two nights must not write memory/ at once. A hand run never backs up.
  const states = () => ({
    backfill: readBackfill(),
    backup: readState("backup"),
    midday: readMidday(),
    night: readState(),
  });
  const turn = force
    ? "night"
    : turnOf(now, day, { ...states(), quota: await quota() });
  const code =
    turn === "night"
      ? ((await locked(() => runNight(days, now, day, force))) ?? Number(force))
      : await daytime(turn, now, day);
  // The Past calendar follows the moments each tick (past.ts); a failure only logs, the next tick tries again.
  await syncPast(now).then(
    (r) => r && console.log(JSON.stringify({ past: r })),
    (e) => log("run.error", { error: String(e), step: "past" })
  );
  const { backup: was, night: state } = states();
  if (force || !backupDue(now.getHours(), day, state, was)) {
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

/** A tick's work when it is not the night's. */
function daytime(turn: "midday" | "backfill" | "none", now: Date, day: string) {
  if (turn === "midday") {
    return midday(now);
  }
  return turn === "backfill" ? backfilled(day) : Promise.resolve(0);
}

/**
 * A midday run (about 13:00 and 19:00, same 30-minute tick): moments and extract of today, so the day's speech is read
 * while it is fresh, then the index, then the pages that have new observations. No commit, no email: the nightly
 * commits and reports all of it, from the ledger. Holds the nightly's lock; `force` (a hand run) skips the schedule,
 * never the lock. A failure is only logged, and the slot is spent.
 */
export async function midday(now = clock(), force = false) {
  if (!(force || middayDue(now, readMidday()))) {
    return 0;
  }
  // Pages follow the day: only a page with new observations is rewritten (a quiet one keeps its file).
  const code = await locked(() => {
    recordMidday();
    return sweep("memory.midday", lastDays(now, 1), () =>
      pages({ rebuild: false })
    );
  });
  return code ?? Number(force);
}

/**
 * One week of the backfill (`bun life memory backfill` sets its range) on a tick with no night and no midday to run:
 * a sweep under the lock, then the range moves on. The past is read oldest first, a week per tick, a few a day, only
 * after the day's night (`backfillWeek`), so it never keeps the nights, the midday runs or the backup from their turn,
 * nor uses his subscriptions all day; a week read already costs nothing (the steps' caches).
 */
async function backfilled(day: string) {
  const code = await locked(async () => {
    const b = readBackfill();
    const week = backfillWeek(b, day, readState());
    if (!(b && week)) {
      return 0;
    }
    const done = await sweep("memory.backfill", week);
    recordBackfill(afterWeek(b, week, done === 0, day));
    return done;
  });
  return code ?? 0;
}

/**
 * One sweep without commit or email: the evidence of `window`, read once for moments and extract, then `then` (the
 * midday's pages), then the index; recorded as `name`, every step's failure caught and logged. The caller holds the
 * lock.
 */
async function sweep(
  name: string,
  window: Window,
  then?: () => Promise<{ failed: number }>
) {
  const rec = await metered(name, { ...window });
  const phase = phases(rec);
  try {
    phase.at = "gather";
    const evidence = await gather(window, await readPeople());
    const found = await phase.step("moments", () => moments(evidence));
    console.log(JSON.stringify(found));
    const extracted = await phase.step("extract", () => extract(evidence));
    console.log(JSON.stringify(extracted));
    if (then) {
      await phase.step("pages", then);
    }
    phase.at = "index";
    await reindex();
    await rec.end({ outcome: "ok" });
    return 0;
  } catch (e) {
    await rec.end(phase.failed(e));
    return 1;
  }
}

/**
 * Each unit he marked "hey Life" that an extract run read since `since` (midday ones too), with the observations citing its
 * lines, or "nothing held": a miss shows the next morning. ponytail: a mark whose unit is never read (said in a note
 * recording, or a unit a code rule drops) is not listed; list marks with no read unit if one goes missing.
 */
export function markedSince(
  built: Built[],
  latest: Map<string, Extracted>,
  since: string,
  observations: Observation[]
) {
  // Read on its marked content (its latest extraction): a reading before the mark landed doesn't count.
  const read = (u: Built["unit"]) => {
    const e = latest.get(u.id);
    return !!e && e.unitHash === u.hash && e.at >= since;
  };
  return built.flatMap(({ unit }) => {
    const marked = unit.marked ?? [];
    if (marked.length === 0 || !read(unit)) {
      return [];
    }
    const held = observations.filter((o) => marked.includes(o.source.ref));
    return [
      {
        name: localTime(unit.start),
        relation: `${unit.title} → ${held.length > 0 ? held.map((o) => o.text).join(" · ") : "nothing held"}`,
      },
    ];
  });
}

/**
 * What the night found, from the ledger: the observations that show and are new since `since` (`newSince`) and about
 * the night's days from `from` (not a backfilled past), the salience-3 page lines not retired, by their home page
 * (`placed`), and the retirements those new observations made.
 */
async function whatIsNew(since: string, from: string, built: Built[]) {
  const people = await readPeople();
  const { all, observations, standing } = await observationsNow(people);
  const isNew = newSince(all, since);
  const fresh = observations.filter((o) => o.date >= from && isNew(o));
  const ids = new Set(fresh.map((o) => o.id));
  const { homes } = placed(
    observations,
    people.truth,
    await pagedNow(people.truth)
  );
  return {
    facts: [...homes].flatMap(([home, lines]) =>
      lines.flatMap(({ o }) =>
        ids.has(o.id) && o.salience === 3 && !standing.retired.has(o.id)
          ? [{ id: o.id, page: people.names.get(home) ?? home, text: o.text }]
          : []
      )
    ),
    marked: markedSince(built, standing.latest, since, observations),
    observed: fresh.length,
    retired: [...standing.retired.values()].filter(
      (s) => ids.has(s.by) && s.by !== s.observation
    ).length,
  };
}

/**
 * What the sweeps of the last 24 h spent of his Codex plan, a line each, oldest first; this night's to `now`, the
 * quota just read for the email.
 */
async function spent(rec: Metered, now: Quota | undefined) {
  const since = new Date(rec.now.getTime() - DAY_MS).toISOString();
  const { items } = await runs({
    limit: 20,
    steps: ["memory.nightly", "memory.midday", "memory.backfill"],
  });
  return items
    .filter((r) => (r.startedAt ?? "") >= since && r.use)
    .reverse()
    .map((r) =>
      r.id === `memory.nightly/${rec.run}` && r.use
        ? `Codex use, this night: ${useText({ ...r.use, quota: { after: now ?? null, before: r.use.quota?.before ?? null } })}`
        : `Codex use, ${r.step.replace("memory.", "")} of ${localTime(r.startedAt ?? "")}: ${useText(r.use ?? null)}`
    );
}

async function runNight(days: number, now: Date, day: string, force: boolean) {
  // Recorded inside the lock (not at `now`, from before it), so a night in progress reads as running.
  const window = lastDays(now, days);
  const rec = await metered("memory.nightly", { ...window, force });
  // Lines first cited since the last good night (with no guard state, the window) are new in this report, midday runs' too.
  const last = readState();
  const since =
    last?.okAt ?? last?.lastAt ?? dayStart(window.from).toISOString();
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
    const evidence = await gather(window, await readPeople());
    const found = await phase.step("moments", () => moments(evidence));
    const extracted = await phase.step("extract", () => extract(evidence));
    // Who is close decides who has a page: judged before the pages and the report's homes.
    await phase.step("closeness", () => closeness());
    const { facts, marked, observed, retired } = await whatIsNew(
      since,
      window.from,
      evidence.built
    );
    const paged = await phase.step("pages", () => pages({ rebuild: false }));
    phase.at = "index";
    await reindex();
    phase.at = "actions";
    const report = await acted(now, rec);
    const commits = await coded(day, rec);
    const archive = await archiveLine(since);
    phase.at = "commit";
    commitMemory(["memory", "truth"], `Memory: ${day}`);
    const q = await quota();
    mail = successReport(day, rec.ms(), {
      acted: report,
      archive,
      backup: backupLine(now),
      code: commits,
      extracted,
      facts,
      files: evidence.files,
      from: window.from,
      marked,
      moments: found,
      observed,
      paged,
      quota: quotaLine(q),
      repos,
      retired,
      spent: await spent(rec, q),
      watcher,
    });
    listed = facts.map((f) => f.id);
  } catch (e) {
    failure = phase.failed(e);
    mail = failureReport(day, rec.ms(), failure.failedAt, failure.error);
  }
  const { attempts } = recordState(day, !failure);
  await rec.end({ attempts, listed, ...(failure ?? { outcome: "ok" }) });
  if (!failure || force || attempts >= MAX_ATTEMPTS) {
    const id = await sendReport(reportKey(rec.run), mail);
    console.log(id ? `report emailed: ${id}` : "report email not sent");
  }
  return failure ? 1 : 0;
}
