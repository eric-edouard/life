import { clock, DAY, daysBefore } from "../core/clock";
import { type LogEvent, logDays } from "../core/log";
import type { SourceName } from "../core/names";
import type { Descriptor } from "../sources/contract";
import { readIndex } from "./memory-files";
import { assembleRuns, modelCallsOf, runEvents } from "./run-log";
import { SOURCES, tablesOf } from "./sources";
import { lastDays, localDate } from "./zones";

// `bun life memory source-use [--days 7]`: what each source costs a day, from the run log (each model call's `reads`,
// tokens and cost) and the index (units and items a day). Bounded: the window's log days and one indexed query.

type Row = SourceName | "memory";
/** A source's units and items on one local day, as the index counts them. */
export interface UnitDay {
  date: string;
  items: number;
  source: string;
  units: number;
}
interface Spread {
  max: number;
  median: number;
}
export interface SourceUse {
  /** Items a day (messages, turns, notes, commits) and the units they form. */
  items: Spread;
  /** The model steps that read it, each with the processing run it ran in (or alone) and its calls. */
  model: { calls: number; step: string }[];
  /** What reads it with no model: `gather`, the tables it is in, the events poll. */
  modelFree: string[];
  /** Units the calls read, over the units it formed (null with no unit). */
  readsPerUnit: number | null;
  source: Row;
  /** Mean a day, each call's tokens and dollars split over its sources by their share of its units. */
  tokensADay: number;
  units: Spread;
  /** Units the calls read, summed over its calls. */
  unitsRead: number;
  /** Calls reading it with no cost from their provider. */
  unpriced: number;
  usdADay: number;
  usdWorstDay: number;
}

const spreadOf = (perDay: number[]): Spread => {
  const sorted = perDay.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    max: sorted.at(-1) ?? 0,
    median:
      sorted.length % 2
        ? (sorted[mid] ?? 0)
        : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2,
  };
};

/** Each step's run id to its name and the processing run it ran in: "extract (nightly)", "closeness (alone)". */
function stepNamesOf(events: LogEvent[]) {
  const list = assembleRuns(events, null);
  const byId = new Map(list.map((r) => [r.id, r]));
  const name = (step: string) => step.replace("memory.", "");
  return new Map(
    list.map((r) => {
      const within = r.processingRun && byId.get(r.processingRun);
      return [
        r.id.slice(r.step.length + 1),
        `${name(r.step)} (${within ? name(within.step) : "alone"})`,
      ];
    })
  );
}

type Spent = Omit<SourceUse, "items" | "units" | "modelFree" | "readsPerUnit">;

/** The calls' `model.run` lines folded by source, each split by its units' share; `usdOn` by source and local day. */
function spentOf(events: LogEvent[], days: number) {
  const stepOf = stepNamesOf(events);
  const rows = new Map<Row, Spent>();
  const usdOn = new Map<string, number>();
  const rowOf = (source: Row) => {
    const row = rows.get(source) ?? {
      model: [],
      source,
      tokensADay: 0,
      unitsRead: 0,
      unpriced: 0,
      usdADay: 0,
      usdWorstDay: 0,
    };
    rows.set(source, row);
    return row;
  };
  // ponytail: a step's calls of one day are split together by their units' share (not each call alone, nor by
  // characters); split per call if one step's calls read very different sources.
  const byStepDay = modelCallsOf(events, (e) => `${e.run}|${localDate(e.at)}`);
  for (const [key, c] of byStepDay) {
    const [run = "", date = ""] = key.split("|");
    const reads = Object.entries(c.reads) as [Row, number][];
    const total = reads.reduce((n, [, x]) => n + x, 0);
    const step = stepOf.get(run) ?? "unknown";
    for (const [source, n] of reads) {
      const row = rowOf(source);
      const share = n / total;
      row.unitsRead += n;
      row.tokensADay += ((c.tokens.input + c.tokens.output) * share) / days;
      row.usdADay += (c.costUsd * share) / days;
      row.unpriced += c.unpriced;
      const day = `${source} ${date}`;
      usdOn.set(day, (usdOn.get(day) ?? 0) + c.costUsd * share);
      const read = row.model.find((m) => m.step === step);
      if (read) {
        read.calls += c.calls;
      } else {
        row.model.push({ calls: c.calls, step });
      }
    }
  }
  return { rowOf, usdOn };
}

/**
 * Each source's use over `days` (local days; a day with nothing counts as 0), from the window's run and call lines
 * (`events`), its unit-days and the registry: pure.
 */
export function sourceUseOf(
  events: LogEvent[],
  unitDays: UnitDay[],
  sources: Descriptor[],
  days: string[]
): SourceUse[] {
  const tables = Object.entries(tablesOf(sources));
  const { rowOf, usdOn } = spentOf(events, days.length);
  const names: Row[] = [...sources.map((s) => s.name), "memory"];
  return names.map((source) => {
    const desc = sources.find((s) => s.name === source);
    const mine = unitDays.filter((u) => u.source === source);
    const on = (d: string, k: "items" | "units") =>
      mine.find((u) => u.date === d)?.[k] ?? 0;
    const units = mine.reduce((n, u) => n + u.units, 0);
    const row = rowOf(source);
    return {
      ...row,
      items: spreadOf(days.map((d) => on(d, "items"))),
      model: row.model.toSorted((a, b) => b.calls - a.calls),
      modelFree: desc
        ? [
            "gather",
            ...tables.flatMap(([n, t]) => (source in t ? [n] : [])),
            ...(desc.incoming ? ["events"] : []),
          ]
        : [],
      readsPerUnit: units > 0 ? row.unitsRead / units : null,
      units: spreadOf(days.map((d) => on(d, "units"))),
      usdWorstDay: Math.max(
        0,
        ...days.map((d) => usdOn.get(`${source} ${d}`) ?? 0)
      ),
    };
  });
}

/**
 * The calls of the last `days` × 24 h, and the units of the `days` local days ending today, read from the log and the
 * index.
 */
export async function readSourceUse(days: number) {
  const now = clock();
  const { from, to } = lastDays(now, days);
  const window = Array.from({ length: days }, (_, i) =>
    daysBefore(to, days - 1 - i)
  );
  const since = new Date(now.getTime() - days * DAY).toISOString();
  // A log file is named by its day: one more covers the hours before the first.
  const events = (await logDays())
    .slice(0, days + 1)
    .flatMap((n) => runEvents(n))
    .filter((e) => e.kind !== "model.run" || e.at >= since);
  const unitDays =
    readIndex((db) =>
      db
        .query<UnitDay, [string, string]>(
          "select source, date, count(*) as units, coalesce(sum(items), 0) as items from units where date between ? and ? group by source, date"
        )
        .all(from, to)
    ) ?? [];
  return sourceUseOf(events, unitDays, SOURCES, window);
}

const n1 = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const usd = (x: number) => `$${x.toFixed(2)}`;
const kTokens = (x: number) => `${Math.round(x / 1e3)}k`;

/** The table in words: one line a source, then what it leaves out. */
export function sourceUseText(use: SourceUse[], days: number) {
  const header = `Source use, last ${days} day${days === 1 ? "" : "s"} (items and units a day: median/max)`;
  const lines = use.flatMap((u) => [
    [
      u.source.padEnd(13),
      `items ${n1(u.items.median)}/${u.items.max}`.padEnd(16),
      `units ${n1(u.units.median)}/${u.units.max}`.padEnd(14),
      `reads/unit ${u.readsPerUnit === null ? "-" : n1(u.readsPerUnit)}`.padEnd(
        16
      ),
      `${kTokens(u.tokensADay)} tokens/day`.padEnd(17),
      `${usd(u.usdADay)}/day (worst ${usd(u.usdWorstDay)})${u.unpriced > 0 ? `, ${u.unpriced} unpriced` : ""}`,
    ].join(" "),
    `    model-free: ${u.modelFree.join(", ") || "-"}`,
    `    model: ${u.model.map((m) => `${m.step} ×${m.calls}`).join(", ") || "-"}`,
  ]);
  return [
    header,
    ...lines,
    "Agent turns: not counted here (his subscriptions).",
  ].join("\n");
}

/** The nightly email's line from `readSourceUse(1)`: every source a call read in the last 24 h, no cap. */
export function sourceUseLine(use: SourceUse[]) {
  const read = use.filter((u) => u.unitsRead > 0);
  return read.length === 0
    ? []
    : [
        `By source, last 24 h: ${read
          .map(
            (u) =>
              `${u.source} ${usd(u.usdADay)} (${u.unitsRead} units read${u.unpriced > 0 ? `, ${u.unpriced} calls unpriced` : ""})`
          )
          .join(", ")}`,
      ];
}
