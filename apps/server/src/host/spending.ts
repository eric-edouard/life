import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { readRun } from "../apify/backend";
import { clock, daysBefore } from "../core/clock";
import { isThere, readJson, writeJson } from "../core/files";
import { type LogEvent, log, logDays, logEvents } from "../core/log";
import { errorOf } from "../core/log-line";
import { LIFE_STATE_DIR } from "../core/paths";
import { readMonthlyUsd, settings } from "../core/settings";
import { decisionsNow } from "../memory/decisions";
import { instructionsFor } from "../memory/instructions";
import { assembleRuns } from "../memory/run-log";
import {
  type Basis,
  type Spend,
  type SpendKind,
  type SpendProvider,
  spendOfApifyRun,
  spendsOf,
  spendsOfVoice,
} from "../memory/spends";
import { dayNow, dayRange, dayStart } from "../memory/zones";
import { voiceServerMissing } from "../sources/voice-server-call";
import { readVoiceSpending } from "../sources/voice-server-spending";
import { activeAgents, readDesk } from "./desk-read";
import { turnsEndedIn } from "./desk-turn-reads";

// Model spending rolled up by his local day (decision 83): `LIFE_STATE_DIR/spending/<day>.json`, written whole by the
// night for closed days that have none, never edited, so ten years of spending outlive the log's year. A day is read
// from its records where they are (`spendsOf`): its log lines, the desk's turns ended in it, Voice's `GET /spending`.

const SPENDING_DIR = join(LIFE_STATE_DIR, "spending");
/** Days written a night, newest first: a Mac off for weeks catches up a week a night. */
const DAYS_A_NIGHT = 7;
/** A day that still holds Voice jobs not settled waits; past this many days it is written with their count. */
const SETTLE_DAYS = 7;

/** One provider's or kind's sum: dollars billed (reported ones), tokens, their list-price equivalent, apart. */
export interface SpendingSum {
  billedUsd: number;
  calls: number;
  equivalentUsd: number;
  tokens: number;
}
export interface ProviderSpending extends SpendingSum {
  basis: Basis;
  provider: SpendProvider;
  /** False when one of its spends came without its amount: its sums are a floor. */
  reported: boolean;
}
export interface KindSpending extends SpendingSum {
  kind: SpendKind;
}
export interface DaySpending {
  byKind: KindSpending[];
  byProvider: ProviderSpending[];
  day: string;
  /** Voice jobs and runs, and Apify runs, still unsettled when the day was written (after `SETTLE_DAYS`): not counted. */
  unsettled: number;
}

const NO_SUM: SpendingSum = {
  billedUsd: 0,
  calls: 0,
  equivalentUsd: 0,
  tokens: 0,
};
const sumOf = (a: SpendingSum, s: Spend): SpendingSum => ({
  billedUsd: a.billedUsd + (s.basis === "billed" ? (s.usd ?? 0) : 0),
  calls: a.calls + s.calls,
  equivalentUsd: a.equivalentUsd + (s.equivalentUsd ?? 0),
  tokens: a.tokens + (s.tokens ? s.tokens.input + s.tokens.output : 0),
});

/** Spends summed by provider and by kind: pure. Billed dollars and the equivalent stay apart. */
export function spendingOf(spends: Spend[]) {
  const providers = new Map<SpendProvider, ProviderSpending>();
  const kinds = new Map<SpendKind, KindSpending>();
  for (const s of spends) {
    const p = providers.get(s.provider);
    providers.set(s.provider, {
      ...sumOf(p ?? NO_SUM, s),
      basis: s.basis,
      provider: s.provider,
      reported: (p?.reported ?? true) && s.reported,
    });
    kinds.set(s.kind, {
      ...sumOf(kinds.get(s.kind) ?? NO_SUM, s),
      kind: s.kind,
    });
  }
  return { byKind: [...kinds.values()], byProvider: [...providers.values()] };
}

/** The log lines spends read, of the files that may hold an instant from `from` to `to` (one UTC file a day, one before for runs begun then). */
function linesIn(names: string[], from: string, to: string) {
  const files = names.filter(
    (n) =>
      n >= `${daysBefore(from.slice(0, 10), 1)}` &&
      n.slice(0, 10) <= to.slice(0, 10)
  );
  const runLines = files.flatMap((n) => logEvents<LogEvent>(n, "run."));
  const spent = files.flatMap((n) => [
    ...logEvents<LogEvent>(n, "model.run"),
    ...logEvents<LogEvent>(n, "model.local"),
  ]);
  return {
    lines: spent.filter((e) => e.at >= from && e.at < to),
    runs: assembleRuns([...runLines, ...spent], null),
  };
}

/** How long after a run ends Apify's bill of it (`usageTotalUsd`) is whole: before, it is still being summed. */
const APIFY_SETTLES_MS = 2 * 60_000;

/** Apify's runs as billed at `now`: a run still running or whose bill is still being summed is unsettled (the day waits, as for Voice). */
export function apifySpendsOf(
  runs: { at: string; finishedAt: string | null; usd: number | null }[],
  now: Date
) {
  const settled = runs.filter(
    (r) =>
      r.finishedAt &&
      now.getTime() - Date.parse(r.finishedAt) >= APIFY_SETTLES_MS
  );
  return {
    spends: settled.map((r) => spendOfApifyRun(r.at, r.usd)),
    unsettled: runs.length - settled.length,
  };
}

/** The Apify runs his yes started from `from` to `to` (each card's `ran`), read from Apify; throws when one can't be read (no token, a failure): the day is tried again, never written without it. */
const readApifySpends = async (from: string, to: string) =>
  apifySpendsOf(
    await Promise.all(
      decisionsNow()
        .flatMap((d) =>
          d.ran?.runId && d.ran.at >= from && d.ran.at < to ? [d.ran] : []
        )
        .map(async (r) => ({
          at: r.at,
          ...(await readRun(r.runId as string, false)),
        }))
    ),
    clock()
  );

/** Voice's spending, or none while Voice is not set up. */
const voiceSpending = (from: string, to: string) =>
  // Set up without its token: it can't be read, so the day waits (never written without Voice).
  voiceServerMissing() && !settings().lifelog?.url
    ? Promise.resolve({ jobs: [], modelRuns: [], unsettled: 0, voiceNotes: [] })
    : readVoiceSpending(from, to);

/**
 * One local day's spends and Voice's unsettled jobs and runs, from its records. Throws when the desk or Voice can't be
 * read (the day is tried again, never written as zero); the desk off or Voice not set up hold nothing.
 */
export async function readDaySpends(
  day: string,
  names?: string[],
  readVoice = voiceSpending,
  readApify = readApifySpends
) {
  const { from = day, to } = dayRange(day, day);
  const { lines, runs } = linesIn(names ?? (await logDays()), from, to);
  const desk = readDesk((db) => turnsEndedIn(db, from, to), [], true);
  if (desk.state === "unreadable") {
    throw new Error(`desk: ${desk.why}`);
  }
  const voice = await readVoice(from, to);
  const apify = await readApify(from, to);
  return {
    spends: [
      ...spendsOf(lines, runs, desk.state === "ok" ? desk.value : []),
      ...spendsOfVoice(voice),
      ...apify.spends,
    ],
    unsettled: voice.unsettled + apify.unsettled,
  };
}

const fileOf = (day: string) => join(SPENDING_DIR, `${day}.json`);

/** A day's spending as the night wrote it, or undefined. */
export const readSpendingDay = (day: string) =>
  readJson<DaySpending>(fileOf(day));

/**
 * The night's step: each closed local day of the log's year with no day file, newest first, that the log holds whole
 * (its first UTC file still kept) and holds anything of; at most `DAYS_A_NIGHT` read, each on its own (one failing is
 * logged and tried the next night). A day still holding unsettled Voice work waits, up to `SETTLE_DAYS`. The desk is
 * read even while off, and Voice set up without its token is a failed read. What it wrote.
 */
export async function writeSpendingDays(
  today = dayNow(),
  readVoice = voiceSpending
) {
  const names = (await logDays()).toSorted();
  const first = names[0]?.slice(0, 10);
  const written: string[] = [];
  let tries = 0;
  for (
    let day = daysBefore(today, 1);
    first && day >= first && tries < DAYS_A_NIGHT;
    day = daysBefore(day, 1)
  ) {
    // Its local bounds, never clamped to now: a day is read only once its next local midnight has passed.
    const from = dayStart(day).toISOString();
    const to = dayStart(daysBefore(day, -1)).toISOString();
    // Read only a closed day whose whole span the log still holds (its first UTC file kept) and holds anything of: a
    // UTC file covers its day, `to` excluded.
    const isHeld =
      first <= from.slice(0, 10) &&
      names.some(
        (n) =>
          n.slice(0, 10) >= from.slice(0, 10) &&
          `${n.slice(0, 10)}T00:00:00.000Z` < to
      );
    if (isThere(fileOf(day)) || !isHeld || to > clock().toISOString()) {
      continue;
    }
    // Every day read counts once, written, waiting or failed.
    tries += 1;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one day at a time, each on its own
      const { spends, unsettled } = await readDaySpends(day, names, readVoice);
      if (unsettled === 0 || day <= daysBefore(today, SETTLE_DAYS)) {
        writeJson(fileOf(day), { ...spendingOf(spends), day, unsettled });
        written.push(day);
      }
    } catch (e) {
      log("run.error", { ...errorOf(e), day, step: "memory.nightly.spending" });
    }
  }
  return written;
}

/** The days of `today`'s month before it, oldest first: the closed days its spending is read from. */
const closedDaysOfMonth = (today: string) => {
  const days: string[] = [];
  for (let d = `${today.slice(0, 7)}-01`; d < today; d = daysBefore(d, -1)) {
    days.push(d);
  }
  return days;
};

/**
 * The month's billed spending against his monthly amount (`budget.monthlyUsd`; his subscriptions don't count): spent on
 * its closed days (the night's day files) and that pace projected to the month's end. None without an amount.
 */
export function monthBudgetOf(today = dayNow()) {
  const monthly = readMonthlyUsd();
  if (monthly === undefined) {
    return;
  }
  const closed = closedDaysOfMonth(today);
  const spent = closed.reduce(
    (n, d) => n + billedOf(readSpendingDay(d) ?? { byProvider: [] }),
    0
  );
  const [y = 0, m = 0] = today.split("-").map(Number);
  const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    isPassed: spent >= monthly,
    monthly,
    projected: (spent / Math.max(closed.length, 1)) * inMonth,
    spent,
  };
}

/** A day's billed dollars, every provider's. */
export const billedOf = (d: Pick<DaySpending, "byProvider">) =>
  d.byProvider.reduce((n, p) => n + p.billedUsd, 0);

/** One piece of work's share of the month: 2%, three times that for an important one (`isImportant`). */
const STOP_SHARE = 0.02;
const IMPORTANT_TIMES = 3;
const AMOUNT = /\d+(?:[.,]\d+)?/;

/**
 * Where one piece of work stops and asks him (the v4 plan, bundle E), in billed dollars: what a `budget` instruction on
 * it says (its first number), else 2% of the monthly amount, three times that when important; none without either.
 * ponytail: the instruction's number is read as dollars, whatever currency its words name.
 */
export function spendingStopOf(
  monthly: number | undefined,
  isImportant: boolean,
  budget?: string
) {
  const said = budget ? AMOUNT.exec(budget)?.[0] : undefined;
  if (said) {
    return Number(said.replace(",", "."));
  }
  return monthly === undefined
    ? undefined
    : monthly * STOP_SHARE * (isImportant ? IMPORTANT_TIMES : 1);
}

/** Project `project`'s cap: its latest `budget` instruction scoped to it (`project:<id>`, recorded at "Build it", the owner's decisions of 28 Nov 2026); none: no cap. */
export const projectBudgetOf = (project: string) =>
  instructionsFor({ projects: [project] }).findLast(
    (i) => i.effect === "budget" && i.scope === `project:${project}`
  );

/** Matter `matter`'s own budget: its latest `budget` instruction scoped to it, else the latest scoped to everything; none: the default stop. */
export function matterBudgetOf(matter: string) {
  const budgets = instructionsFor({ matter }).filter(
    (i) => i.effect === "budget"
  );
  return (
    budgets.findLast((i) => i.scope === `matter:${matter}`) ??
    budgets.findLast((i) => i.scope === "all")
  );
}

/** What a project with no room says on its quiet line, in place of its agent's. */
export const WAITS_FOR_ROOM = "Waits for room in this month's amount";

/**
 * The projects with no room (the owner's decisions of 28 Nov 2026): the caps of running projects add up within the
 * month's amount, the oldest cap first; one that does not fit waits until one before it ends or is lowered. None
 * without a monthly amount. Pure.
 */
export function projectsWithoutRoomOf(
  caps: readonly { at: string; project: string; usd: number }[],
  monthly: number | undefined
) {
  let used = 0;
  return new Set(
    monthly === undefined
      ? []
      : caps
          .toSorted((x, y) => x.at.localeCompare(y.at))
          .flatMap((c) => {
            // In cents, so caps that fit exactly fit (0.1 + 0.2 is not 0.3 in floats).
            const cents = Math.round(c.usd * 100);
            if (used + cents <= Math.round(monthly * 100)) {
              used += cents;
              return [];
            }
            return [c.project];
          })
  );
}

/** The projects of the active agents that wait for room now (`projectsWithoutRoomOf`), their caps read from his instructions. */
export function readProjectsWithoutRoom(db: Database) {
  const projects = new Set(
    activeAgents(db).flatMap((a) => (a.project ? [a.project] : []))
  );
  const caps = [...projects].flatMap((project) => {
    const b = projectBudgetOf(project);
    const usd = b && spendingStopOf(undefined, false, b.text);
    return b && usd !== undefined ? [{ at: b.at, project, usd }] : [];
  });
  return projectsWithoutRoomOf(caps, readMonthlyUsd());
}
