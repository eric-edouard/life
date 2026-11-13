import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { clock, DAY, daysBefore, iso } from "../core/clock";
import { filesIn } from "../core/files";
import { holder, isOtherLife } from "../core/lock";
import { LOG_DIR, log, logDays, recentEvents } from "../core/log";
import type { Engine } from "../core/names";
import { isOn } from "../core/outputs";
import { settings } from "../core/settings";
import { appointments } from "../memory/appointments";
import {
  closeness,
  lastYearsOf,
  pagedNow,
  readWithPeople,
} from "../memory/closeness";
import { writeContactPeople } from "../memory/contact-people";
import { readBirthdaysNear } from "../memory/details";
import { episodes } from "../memory/episodes";
import { writeExchangeCounts } from "../memory/exchange-counts";
import {
  type ExchangeReadWork,
  exchangeReads,
  readExchangeReadWork,
} from "../memory/exchange-reads";
import { extract } from "../memory/extract";
import { topUpFactChecks } from "../memory/fact-checks";
import { histories, readHistoryWork } from "../memory/histories";
import { reindex } from "../memory/index-writer";
import { links, readLinkWork } from "../memory/links";
import {
  commitMemory,
  newSince,
  OUT,
  readLedger,
} from "../memory/memory-files";
import { locked } from "../memory/memory-lock";
import { placed } from "../memory/page-format";
import { pages } from "../memory/pages";
import { personas } from "../memory/personas";
import { writeRecordedDays } from "../memory/recorded-days";
import { codeOn, mapRepos } from "../memory/repos";
import {
  type Metered,
  metered,
  type RunRecorder,
  trackProcessingSteps,
} from "../memory/run";
import { type Run, runs, SPENDING, spendLines } from "../memory/run-log";
import {
  afterNightDue,
  afterWeek,
  backfillWeek,
  isOutOfTries,
  quotaLine,
  readBackfill,
  readState,
  recordBackfill,
  recordState,
  spareQuota,
  turnOf,
} from "../memory/schedule";
import { situations } from "../memory/situations";
import { keptStores } from "../memory/sources";
import { type Built, gather } from "../memory/units";
import { observationsNow, readPeople } from "../memory/who";
import {
  dayNow,
  dayStart,
  lastDays,
  localDate,
  localTime,
  noteZone,
  readZoneHere,
  type Window,
} from "../memory/zones";
import { hasQuota, isOnline, type Quota, quota } from "../models/llm";
import { isListed, type LedgerEntry } from "../records/ledger-entry";
import type { Extracted, Observation } from "../records/observation";
import { TOP_AT } from "../records/unit";
import { checks } from "../todo-list/backend";
import { syncAppointments } from "./appointments-calendar";
import { ARCHIVE_LOOKBACK, openIncidents } from "./archive";
import { backup, backupLine } from "./backup";
import { healBridges } from "./bridges";
import { syncPast } from "./past-calendar";
import {
  failureReport,
  type Mail,
  redReport,
  reportKey,
  sendReport,
  successReport,
} from "./report";
import { redCards, snapshot } from "./status/snapshot";

/** The report's Actions: what Life did in the last 24 h and what stops it from acting. Never fails the night: a failure is one more problem. */
async function acted(now: Date, rec: Pick<RunRecorder, "error">) {
  const problems = await checks();
  let actions: readonly LedgerEntry[] = [];
  try {
    actions = readLedger();
  } catch (e) {
    const { message } = e as Error;
    problems.push(`ledger.jsonl: ${message}`);
    rec.error(message, { step: "memory.nightly.actions" });
  }
  return {
    actions: actions.filter(
      (a) => isListed(a) && Date.parse(a.at) >= now.getTime() - DAY
    ),
    problems,
  };
}

/** Yesterday's Code rows. Never fails the night: a failure is logged and there are no rows. */
function coded(day: string, rec: Pick<RunRecorder, "error">) {
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
 * Repo map, episodes (who the unknown people are too), extract, pages, index, then one commit "Memory: <date>" and one report email. A failed
 * step stops the run with nothing committed; the next run resumes (every step caches). launchd starts it every 30
 * minutes; unless `force`, a start does nothing before 05:00, once the day is ok, or after 3 failures (schedule.ts), and
 * a failure email goes once no try is left (`isOutOfTries`; a backfill week's too). What a tick runs is `turnOf`'s: the night, else a backfill week,
 * not over the Codex quota's reserve (`reserved`), read each tick. Today, before its night, is the watcher's
 * (`buildTodayUnits`): its units, raw, no episodes or facts until the night (his decision, 11 Nov 2026). Then the daily backup, when it is due
 * (`afterNightDue`: the night is done, on this tick or before).
 */
export async function nightly(days: number, force = false) {
  // Another install's watcher runs on this Mac (the move to the app, or a copy's own state): only that install's ticks
  // run (two would each send a report and fight over the Past calendar). Only a hand `--force` runs beside it.
  const live = holder("watch");
  if (!force && isOtherLife(live)) {
    console.log(`another Life runs here (${live?.note}): no tick`);
    return 0;
  }
  // Offline (`isOnline`): the tick runs nothing, so it spends no try and alerts nothing.
  if (!(force || (await isOnline()))) {
    log("offline");
    console.log("offline: no tick");
    return 0;
  }
  const now = clock();
  // Each tick is a fresh process: the place to notice he moved (`readZoneHere`, never a TZ variable). The phone's
  // zone is read before the lock: a network read never holds memory.
  const here = await readZoneHere();
  await locked(() => noteZone(here, now));
  const day = localDate(now.toISOString());
  // `force` skips the day's schedule, never the lock: two nights must not write memory/ at once. A hand run never backs up.
  const states = () => ({
    // Historical model work waits for frozen prompts; collection uses `memory historical-units`.
    backfill: undefined,
    backup: readState("backup"),
    bridges: readState("bridges"),
    night: readState(),
  });
  const turn = force
    ? "night"
    : turnOf(now, day, { ...states(), quota: await quota() });
  let code = 0;
  if (turn === "night") {
    code =
      (await locked(() => runNight(days, now, day, force))) ?? Number(force);
  } else if (turn === "backfill") {
    code = await backfilled(day);
  }
  // The appointments first, with their own catch: the Past calendar's whole sync after the night must not spend
  // Google's rate limit before them.
  await syncAppointments(now).then(
    (r) => r && console.log(JSON.stringify({ appointments: r })),
    (e) => log("run.error", { error: String(e), step: "appointments" })
  );
  // The Past calendar follows the episodes each tick, those ending in the last 3 days, and the whole of it after the
  // night (past-calendar.ts); a failure only logs, the next tick tries again.
  await syncPast(
    turn === "night" ? undefined : new Date(now.getTime() - 3 * DAY),
    now
  ).then(
    (r) => r && console.log(JSON.stringify({ past: r })),
    (e) => log("run.error", { error: String(e), step: "past" })
  );
  // The bridges' daily restart (`healBridges`), before the source alert judges them; a failure only logs.
  const { bridges, night } = states();
  if (!force && afterNightDue(now.getHours(), day, night, bridges)) {
    const healed = await healBridges().then(
      () => true,
      (e) => {
        log("run.error", { error: String(e), step: "bridges" });
        return false;
      }
    );
    recordState(day, healed, "bridges");
  }
  // Every card in red on the status snapshot, the one judge of Life's health: an email when a card's problem is new
  // that day. After the turn, so no run waits on it; a failure only logs.
  try {
    const red = redCards((await snapshot()).cards);
    if (red.length > 0) {
      await sendReport(
        red.map((c) => `alert/${c.id}/${c.word}/${dayNow(clock())}`),
        redReport(clock().toISOString(), red)
      );
    }
  } catch (e) {
    log("run.error", { error: String(e), step: "alert" });
  }
  const { backup: was, night: state } = states();
  if (force || !afterNightDue(now.getHours(), day, state, was)) {
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
 * His chats and mail of every year, read once. The exchange counts are written from all of it at once (derived; a
 * failure is logged and the last file stands), and the pending work of the histories (`readHistoryWork`, only while
 * his `history` setting is on) and of the exchange reads (`readExchangeReadWork`, only while his `exchangeReads`
 * setting is on) is taken from it, so only the last years stay in memory for closeness and the personas.
 */
async function readYears(now: Date) {
  const everyYear = await readWithPeople(new Date(0));
  const people = await readPeople();
  writeExchangeCounts(everyYear, people.resolve);
  const { histories: history } = settings();
  // Off until his `history` setting. A failure is logged and the night goes on, its months read another night.
  const pending = history
    ? await readHistoryWork(everyYear, people, {
        from: history.from,
        today: localDate(now.toISOString()),
      }).catch((e: Error) => {
        log("run.error", { error: e.message, step: "memory.history" });
        return null;
      })
    : null;
  // Off until his `exchangeReads` setting. A failure is logged and the night goes on, its exchanges read another night.
  let reads: ExchangeReadWork = null;
  if (settings().exchangeReads) {
    try {
      reads = readExchangeReadWork(everyYear, people, now);
    } catch (e) {
      log("run.error", {
        error: (e as Error).message,
        step: "memory.exchange-reads",
      });
    }
  }
  return { pending, reads, withPeople: lastYearsOf(everyYear) };
}

/** The night's links: what is due (`readLinkWork`), judged. */
async function judgeLinks() {
  const people = await readPeople();
  const pending = await readLinkWork(people);
  return pending && links(pending, people);
}

/** A failure while offline is the network's, not the run's: it spends no try and mails nothing; the next online tick runs it again. */
const isOfflineFailure = async (failure: unknown) =>
  Boolean(failure) && !(await isOnline());

/**
 * One week of the backfill (`bun life memory backfill` sets its range) on a tick with no night to run:
 * a processing run under the lock, then the range moves on. The past is read oldest first, a week per tick, a few a day, only
 * after the day's night (`backfillWeek`), so it never keeps the nights or the backup from their turn,
 * nor uses his subscriptions all day; a week read already costs nothing (the steps' caches).
 */
async function backfilled(day: string) {
  const engine = settings().backfillEngine;
  if (!engine) {
    return 0;
  }
  await spareQuota(engine);
  const code = await locked(async () => {
    const b = readBackfill();
    const week = backfillWeek(b, day, readState());
    if (!(b && week)) {
      return 0;
    }
    const failure = await runProcessing("memory.backfill", week, engine);
    if (await isOfflineFailure(failure)) {
      return 1;
    }
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
 * One processing run without commit or email: the evidence of `window`, read once for episodes and facts, then
 * the index; recorded as `name`, every step's failure caught and logged, and returned (null when it went through). The
 * caller holds the lock.
 */
async function runProcessing(name: string, window: Window, engine?: Engine) {
  const rec = await metered(name, { ...window }, engine);
  const steps = trackProcessingSteps(rec);
  try {
    steps.at = "gather";
    const evidence = await gather(window, await readPeople(), { engine });
    const found = await steps.step("episodes", () => episodes(evidence));
    console.log(JSON.stringify(found));
    const extracted = await steps.step("extract", () => extract(evidence));
    console.log(JSON.stringify(extracted));
    steps.at = "index";
    await reindex();
    await rec.end({ outcome: "ok" });
    return null;
  } catch (e) {
    const failure = steps.failed(e);
    await rec.end(failure);
    return { ...failure, ms: rec.ms(), run: rec.run };
  }
}

/**
 * Each unit holding his words to Life (its marks: voice, a message to himself, `tell_life`) that an extract run read since `since` (a backfill's or a hand run's too), with the observations citing its
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
  const { all, observations, statusInputs } = await observationsNow(people);
  const isNew = newSince(all, since);
  const fresh = observations.filter((o) => o.date >= from && isNew(o));
  const ids = new Set(fresh.map((o) => o.id));
  const { homes } = placed(observations, people.truth, await pagedNow(people));
  return {
    keyObservations: [...homes].flatMap(([home, lines]) =>
      lines.flatMap(({ o }) =>
        ids.has(o.id) &&
        o.importance === TOP_AT &&
        !statusInputs.retired.has(o.id)
          ? [{ id: o.id, page: people.names.get(home) ?? home, text: o.text }]
          : []
      )
    ),
    marked: markedSince(built, statusInputs.latest, since, observations),
    observed: fresh.length,
    retired: [...statusInputs.retired.values()].filter(
      (s) => ids.has(s.by) && s.by !== s.observation
    ).length,
  };
}

/**
 * What the model calls of the last 24 h spent, oldest first: a line per run, a processing run's steps each under it (every row,
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

/**
 * Deletes what no one reads past an age: each run's model files (`OUT/runs`) and each eval's judge calls (`OUT/evals`) after 30 days, the event log's
 * days after a year (its readers look back weeks; the backups keep 24 months).
 */
export async function dropOld(now: Date) {
  for (const dir of ["runs", "evals"].map((d) => join(OUT, d))) {
    for (const name of await filesIn(dir, "")) {
      const at = statSync(join(dir, name), { throwIfNoEntry: false });
      if (at && at.mtimeMs < now.getTime() - 30 * DAY) {
        rmSync(join(dir, name), { force: true, recursive: true });
      }
    }
  }
  const yearAgo = `${iso(now.getTime() - 365 * DAY).slice(0, 10)}.jsonl`;
  for (const name of await logDays()) {
    if (name < yearAgo) {
      rmSync(join(LOG_DIR, name), { force: true });
    }
  }
}

async function runNight(days: number, now: Date, day: string, force: boolean) {
  // Recorded inside the lock (not at `now`, from before it), so a night in progress reads as running.
  const window = lastDays(now, days);
  const rec = await metered("memory.nightly", { ...window, force });
  // Lines first cited since the last good night (with no night state, the window) are new in this report, a backfill's or a hand run's too.
  const last = readState();
  const since =
    last?.okAt ?? last?.lastAt ?? dayStart(window.from).toISOString();
  const steps = trackProcessingSteps(rec);
  let mail: Mail;
  // The observations the report lists, in the run record: an audit can tell what he was told.
  let listed: string[] = [];
  let failure: ReturnType<typeof steps.failed> | undefined;
  try {
    const repos = await steps.step("repos", () => mapRepos());
    // Who his Contacts name among the senders Life cannot: before the sources are read, so tonight's units and
    // counts already go by them (derived from Contacts; a failure is logged and the people kept still read).
    writeContactPeople();
    // Every source is read once and handed to each step.
    steps.at = "gather";
    const evidence = await gather(window, await readPeople());
    const found = await steps.step("episodes", () => episodes(evidence));
    const extracted = await steps.step("extract", () => extract(evidence));
    // Who is close decides who has a page: judged before the pages and the report's homes.
    // The days the pendant recorded, for coverage (derived; a failure is logged and the last file stands).
    await writeRecordedDays();
    const { pending, reads, withPeople } = await readYears(now);
    await steps.step("closeness", () => closeness(withPeople));
    const { keyObservations, marked, observed, retired } = await whatIsNew(
      since,
      window.from,
      evidence.built
    );
    const paged = await steps.step("pages", () => pages({ rebuild: false }));
    // Derived and rebuilt each night: a failed call is logged and retried, never stops the night.
    steps.at = "situations";
    await situations();
    steps.at = "appointments";
    // Only while his calendar takes them: nothing else reads the file.
    if (isOn("appointmentsCalendar")) {
      await appointments();
    }
    // After the situations, which read the persona already built: a week's heavy rebuild never holds them up.
    steps.at = "personas";
    await personas(withPeople);
    // The histories' months not read yet: a failure is logged and never stops the night.
    if (pending) {
      steps.at = "histories";
      await histories(pending).catch((e: Error) =>
        log("run.error", { error: e.message, step: "memory.history" })
      );
    }
    // The exchange reads not stored yet: a failure is logged and never stops the night.
    if (reads) {
      steps.at = "exchange reads";
      await exchangeReads(reads).catch((e: Error) =>
        log("run.error", { error: e.message, step: "memory.exchange-reads" })
      );
    }
    steps.at = "fact checks";
    await topUpFactChecks();
    steps.at = "index";
    await reindex();
    // How the open things ended, in shadow and off until his `links` setting: after the index, which says what is open
    // tonight. A failure is logged and never stops the night.
    if (settings().links) {
      steps.at = "links";
      await judgeLinks().catch((e: Error) =>
        log("run.error", { error: e.message, step: "memory.links" })
      );
    }
    steps.at = "actions";
    const report = await acted(now, rec);
    const commits = await coded(day, rec);
    const archive = await archiveLine(since);
    steps.at = "commit";
    commitMemory(["memory", "truth"], `Memory: ${day}`);
    await dropOld(now);
    const q = await quota();
    mail = successReport(day, rec.ms(), {
      acted: report,
      archive,
      backup: backupLine(now),
      birthdays: (await readBirthdaysNear(await readPeople(), dayNow())).map(
        (b) => ({ name: b.name, relation: b.text })
      ),
      code: commits,
      episodes: found,
      extracted,
      files: evidence.files,
      from: window.from,
      keyObservations,
      marked,
      observed,
      paged,
      quota: hasQuota() ? quotaLine(q) : undefined,
      repos,
      retired,
      spent: await spent(rec, q),
    });
    listed = keyObservations.map((f) => f.id);
  } catch (e) {
    failure = steps.failed(e);
    mail = failureReport(
      clock().toISOString(),
      rec.ms(),
      failure.failedAt,
      failure.error
    );
  }
  if (await isOfflineFailure(failure)) {
    await rec.end({ ...failure, offline: true });
    return 1;
  }
  const { attempts } = recordState(day, !failure);
  await rec.end({ attempts, listed, ...(failure ?? { outcome: "ok" }) });
  if (!failure || force || isOutOfTries(attempts)) {
    const id = await sendReport(reportKey(rec.run), mail);
    console.log(id ? `report delivered: ${id}` : "report not delivered");
  }
  return failure ? 1 : 0;
}
