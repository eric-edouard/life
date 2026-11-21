import { join } from "node:path";
import { daysBefore } from "../core/clock";
import { isThere, readJson, writeJson } from "../core/files";
import { type LogEvent, log, logDays, logEvents } from "../core/log";
import { errorOf } from "../core/log-line";
import { LIFE_STATE_DIR } from "../core/paths";
import { assembleRuns } from "../memory/run-log";
import {
  type Basis,
  type Spend,
  type SpendKind,
  type SpendProvider,
  spendsOf,
  spendsOfVoice,
} from "../memory/spends";
import { dayNow, dayRange } from "../memory/zones";
import { lifelogMissing } from "../sources/lifelog-call";
import { readVoiceSpending } from "../sources/lifelog-spending";
import { readDesk, turnsEndedIn } from "./desk-read";

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
  /** Voice jobs still unsettled when the day was written (after `SETTLE_DAYS`): not counted. */
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

/**
 * One local day's spends and Voice's unsettled jobs, from its records. Throws when the desk or Voice can't be read
 * (the day is tried again, never written as zero); the desk off or Voice not set up hold nothing.
 */
/** Voice's spending, or none while Voice is not set up. */
const voiceSpending = (from: string, to: string) =>
  lifelogMissing()
    ? Promise.resolve({ jobs: [], modelRuns: [], voiceNotes: [] })
    : readVoiceSpending(from, to);

export async function readDaySpends(
  day: string,
  names?: string[],
  readVoice = voiceSpending
) {
  const { from = day, to } = dayRange(day, day);
  const { lines, runs } = linesIn(names ?? (await logDays()), from, to);
  const desk = readDesk((db) => turnsEndedIn(db, from, to), []);
  if (desk.state === "unreadable") {
    throw new Error(`desk: ${desk.why}`);
  }
  const voice = await readVoice(from, to);
  return {
    spends: [
      ...spendsOf(lines, runs, desk.state === "ok" ? desk.value : []),
      ...spendsOfVoice(voice),
    ],
    unsettled: voice.jobs.filter((j) => j.outcome === "unsettled").length,
  };
}

const fileOf = (day: string) => join(SPENDING_DIR, `${day}.json`);

/** A day's spending as the night wrote it, or undefined. */
export const readSpendingDay = (day: string) =>
  readJson<DaySpending>(fileOf(day));

/**
 * The night's step: each closed day of the log's year with no day file, newest first, at most `DAYS_A_NIGHT` tried, each on
 * its own (one failing is logged and tried the next night). A day still holding unsettled Voice jobs waits, up to
 * `SETTLE_DAYS`. A day with no log file left has no record to read: it stays absent. What it wrote.
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
    if (isThere(fileOf(day))) {
      continue;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one day at a time, each on its own
      const { spends, unsettled } = await readDaySpends(day, names, readVoice);
      const isSettling = unsettled > 0 && day > daysBefore(today, SETTLE_DAYS);
      tries += isSettling ? 0 : 1;
      if (!isSettling) {
        writeJson(fileOf(day), { ...spendingOf(spends), day, unsettled });
        written.push(day);
      }
    } catch (e) {
      tries += 1;
      log("run.error", { ...errorOf(e), day, step: "memory.nightly.spending" });
    }
  }
  return written;
}
