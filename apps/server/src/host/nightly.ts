import { clock, DAY, HOUR } from "../core/clock";
import { holder, isOtherLife } from "../core/lock";
import { log, recentEvents } from "../core/log";
import { closeness, pagedNow } from "../memory/closeness";
import { extract } from "../memory/extract";
import { askFactChecks } from "../memory/fact-checks";
import { newSince, readLedger } from "../memory/ledger";
import { locked, lockedSince } from "../memory/memory-lock";
import { moments } from "../memory/moments";
import { placed } from "../memory/page-format";
import { pages } from "../memory/pages";
import { codeOn, mapRepos } from "../memory/repos";
import {
  commitMemory,
  type Metered,
  metered,
  phases,
  type RunRecord,
} from "../memory/run";
import { type Run, runs, SPENDING, spendLines } from "../memory/run-log";
import {
  afterWeek,
  backfillWeek,
  backupDue,
  isOutOfTries,
  middayDue,
  quotaLine,
  readBackfill,
  readMidday,
  readState,
  recordBackfill,
  recordMidday,
  recordState,
  turnOf,
} from "../memory/schedule";
import { reindex } from "../memory/search";
import { keptStores } from "../memory/sources";
import { titleOf } from "../memory/tasks";
import {
  type Built,
  daysBefore,
  gather,
  lastDays,
  localTime,
  type Window,
} from "../memory/units";
import { observationsNow, readPeople } from "../memory/who";
import {
  dayNow,
  dayStart,
  localDate,
  noteZone,
  readZoneHere,
} from "../memory/zones";
import { hasQuota, type Quota, quota } from "../models/llm";
import { isListed, type LedgerEntry } from "../records/ledger-entry";
import type { Extracted, Observation } from "../records/observation";
import { checks } from "../todo-list/backend";
import { taskList, unanswered } from "./agent";
import { ARCHIVE_LOOKBACK, openIncidents } from "./archive";
import { backup, backupLine } from "./backup";
import { syncPast } from "./past-calendar";
import {
  failureReport,
  lockReport,
  type Mail,
  reportKey,
  sendReport,
  sourcesReport,
  successReport,
} from "./report";
import { redSources, snapshot } from "./status/snapshot";

/** A run holding the lock longer than this is stuck: the nightly emails once (per lock). */
const STUCK_MS = 3 * HOUR;

/** The report's Actions: what Life did in the last 24 h and what stops it from acting. Never fails the night: a failure is one more problem. */
async function acted(now: Date, rec: Pick<RunRecord, "error">) {
  const problems = await checks();
  let actions: LedgerEntry[] = [];
  let tasks: ReturnType<typeof taskList> = [];
  let gaps = 0;
  try {
    actions = readLedger();
    tasks = taskList(now.getTime());
    gaps = unanswered(now.getTime() - DAY);
  } catch (e) {
    const { message } = e as Error;
    problems.push(`ledger.jsonl: ${message}`);
    rec.error(message, { step: "memory.nightly.actions" });
  }
  // A task's own lines (the agent's updates) are its rows, not actions.
  return {
    actions: actions.filter(
      (a) => isListed(a) && Date.parse(a.at) >= now.getTime() - DAY
    ),
    problems,
    tasks: [
      ...tasks.map((t) => ({
        name: `${t.state} · ${t.age}`,
        relation: `${titleOf(t)} → ${t.note ?? "…"} · deadline ${t.deadline ? localTime(t.deadline) : "none"}`,
      })),
      // The agent logs its replies by the playbook, not by code: the asks it never logged one for show here.
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
 * minutes; unless `force`, a start does nothing before 02:00, once the day is ok, or after 3 failures (schedule.ts), and
 * a failure email goes once no try is left (`isOutOfTries`; a backfill week's too). What a tick runs is `turnOf`'s: the night, else the midday
 * pass (moments, extract, pages) when its slot is open, else a backfill week; neither over the Codex quota's reserve
 * (`reserved`), read each tick. Then the daily backup, when it is due
 * (`backupDue`: the night is done, on this tick or before).
 */
export async function nightly(days: number, force = false) {
  // Another install's watcher runs on this Mac (the move to the app, or a copy's own state): only that install's ticks
  // run (two would each send a report and fight over the Past calendar). Only a hand `--force` runs beside it.
  const live = holder("watch");
  if (!force && isOtherLife(live)) {
    console.log(`another Life runs here (${live?.note}): no tick`);
    return 0;
  }
  const now = clock();
  const held = lockedSince();
  if (held && now.getTime() - held.getTime() > STUCK_MS) {
    await sendReport(
      `lock/${held.toISOString()}`,
      lockReport(held.toISOString())
    );
  }
  // Each tick is a fresh process: the place to notice he moved (`readZoneHere`, never a TZ variable). The phone's
  // zone is read before the lock: a network read never holds memory.
  const here = await readZoneHere();
  await locked(() => noteZone(here, now));
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
  // The Past calendar follows the moments each tick (past-calendar.ts); a failure only logs, the next tick tries again.
  await syncPast(now).then(
    (r) => r && console.log(JSON.stringify({ past: r })),
    (e) => log("run.error", { error: String(e), step: "past" })
  );
  // Every source in red on the status snapshot, the one judge of a source's health: an email when a source's problem
  // is new that day. After the turn, so no run waits on it; a failure only logs.
  try {
    const red = redSources((await snapshot()).cards);
    if (red.length > 0) {
      await sendReport(
        red.map((c) => `source/${c.id}/${c.word}/${dayNow(clock())}`),
        sourcesReport(clock().toISOString(), red)
      );
    }
  } catch (e) {
    log("run.error", { error: String(e), step: "sources" });
  }
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
 * while it is fresh, then the index, then the pages that have new observations, then his fact checks topped up. No
 * commit, no email: the nightly commits and reports all of it, from the ledger. Holds the nightly's lock; `force` (a hand run) skips the schedule,
 * never the lock. A failure is only logged, and the slot is spent: the next slot and the night read the day again.
 */
export async function midday(now = clock(), force = false) {
  if (!(force || middayDue(now, readMidday()))) {
    return 0;
  }
  // Pages follow the day: only a page with new observations is rewritten (a quiet one keeps its file).
  const code = await locked(() => {
    recordMidday();
    return sweep("memory.midday", lastDays(now, 1), {
      pages: () => pages({ rebuild: false }),
    })
      .then(async (failure) => {
        await askFactChecks();
        return failure ? 1 : 0;
      })
      .catch((e) => {
        console.error(`midday fact checks: ${(e as Error).message}`);
        return 1;
      });
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
    const failure = await sweep("memory.backfill", week);
    const next = afterWeek(b, week, !failure, day);
    recordBackfill(next);
    // Its last try failed: the backfill stops, so he hears it, as of a night's last failure.
    if (failure && isOutOfTries(next.failures)) {
      await sendReport(
        `backfill/${failure.run}`,
        failureReport(
          clock().toISOString(),
          failure.ms,
          `memory.backfill ${week.from} to ${week.to}, ${failure.failedAt}`,
          failure.error
        )
      );
    }
    return failure ? 1 : 0;
  });
  return code ?? 0;
}

/**
 * One sweep without commit or email: the evidence of `window`, read once for moments and extract, then `pages` (the
 * midday's pages), then the index; recorded as `name`, every step's failure caught and logged, and returned (null when
 * it went through). The caller holds the lock.
 */
async function sweep(
  name: string,
  window: Window,
  o: { pages?: () => Promise<{ failed: number }> } = {}
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
    if (o.pages) {
      await phase.step("pages", o.pages);
    }
    phase.at = "index";
    await reindex();
    await rec.end({ outcome: "ok" });
    return null;
  } catch (e) {
    const failure = phase.failed(e);
    await rec.end(failure);
    return { ...failure, ms: rec.ms(), run: rec.run };
  }
}

/**
 * Each unit holding one of his asks (its marks) that an extract run read since `since` (midday ones too), with the observations citing its
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
 * the night's days from `from` (not a backfilled past), the importance-3 page lines not retired, by their home page
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
        ids.has(o.id) && o.importance === 3 && !standing.retired.has(o.id)
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
 * What the model calls of the last 24 h spent, oldest first: a line per run, a sweep's steps each under it (every row,
 * no cap); this night's quota to `now`, the reading just made for the email.
 */
async function spent(rec: Metered, now: Quota | undefined) {
  const since = new Date(rec.now.getTime() - DAY).toISOString();
  const recent: Run[] = [];
  let cursor: string | null = null;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: each page starts where the last ended
    const page = await runs({ cursor: cursor ?? undefined, steps: SPENDING });
    recent.push(...page.items);
    ({ cursor } = page);
  } while (cursor && (recent.at(-1)?.startedAt ?? "") >= since);
  return spendLines(recent, since, {
    id: `memory.nightly/${rec.run}`,
    quota: now,
  });
}

async function runNight(days: number, now: Date, day: string, force: boolean) {
  // Recorded inside the lock (not at `now`, from before it), so a night in progress reads as running.
  const window = lastDays(now, days);
  const rec = await metered("memory.nightly", { ...window, force });
  // Lines first cited since the last good night (with no night state, the window) are new in this report, midday runs' too.
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
    phase.at = "fact checks";
    await askFactChecks();
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
      quota: hasQuota() ? quotaLine(q) : undefined,
      repos,
      retired,
      spent: await spent(rec, q),
    });
    listed = facts.map((f) => f.id);
  } catch (e) {
    failure = phase.failed(e);
    mail = failureReport(
      clock().toISOString(),
      rec.ms(),
      failure.failedAt,
      failure.error
    );
  }
  const { attempts } = recordState(day, !failure);
  await rec.end({ attempts, listed, ...(failure ?? { outcome: "ok" }) });
  if (!failure || force || isOutOfTries(attempts)) {
    const id = await sendReport(reportKey(rec.run), mail);
    console.log(id ? `report delivered: ${id}` : "report not delivered");
  }
  return failure ? 1 : 0;
}
