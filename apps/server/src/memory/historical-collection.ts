import { daysBefore } from "../core/clock";
import {
  prepareHistoricalZones,
  readHistoricalZones,
} from "./historical-zones";
import { reindex } from "./index-writer";
import { preparePassages } from "./passages";
import { readySources } from "./sources";
import { publishUnits, unitDays } from "./unit-writer";
import { DAYS, gather } from "./units";
import { readPeople } from "./who";
import { dayNow, isDay, localDate, monthsOf, type Window, wall } from "./zones";

/** A requested historical range ends before the nightly's seven local days. */
export function historicalWindow(
  from: string,
  to = daysBefore(dayNow(), DAYS)
) {
  if (!(isDay(from) && isDay(to) && from <= to)) {
    throw new Error(
      "units needs an ordered --from/--to pair of YYYY-MM-DD dates"
    );
  }
  if (to > daysBefore(dayNow(), DAYS)) {
    throw new Error("units must end before the nightly's seven-day window");
  }
  return { from, to };
}

/** Model-free historical collection, called while holding memory's existing lock. */
export async function collectHistorical(
  requested: { from?: string; to?: string } = {},
  prepareZones = prepareHistoricalZones,
  readZones = readHistoricalZones
) {
  const sources = readySources().filter((s) => s.kind !== "voice");
  const starts = requested.from
    ? []
    : await Promise.all(
        sources.map(async (s) => ("earliest" in s ? s.earliest?.() : undefined))
      );
  const [earliest] = starts.filter((s): s is string => !!s).sort();
  if (!(requested.from || earliest)) {
    return {
      coverage: [],
      deferred: [],
      failed: 0,
      gaps: [],
      months: 0,
      units: 0,
    };
  }
  const window = historicalWindow(
    requested.from ?? daysBefore(wall(earliest as string, "UTC").day, 1),
    requested.to
  );
  const zones = await prepareZones(window);
  if (!requested.from && earliest) {
    window.from = localDate(earliest);
    zones.gaps = zones.gaps.filter((d) => d >= window.from);
    zones.deferred = zones.deferred.filter((d) => d >= window.from);
  }
  const people = await readPeople();
  const coverage: {
    from: string;
    to: string;
    units: number;
    skipped: string[];
  }[] = [];
  let units = 0;
  let hasPublished = false;
  try {
    for (const month of monthsOf(window)) {
      // biome-ignore lint/performance/noAwaitInLoops: publish one bounded month before reading the next
      const evidence = await gather(month, people, { historical: true });
      if (evidence.failed.length > 0) {
        return {
          coverage,
          deferred: zones.deferred,
          failed: evidence.failed.length,
          gaps: zones.gaps,
          months: coverage.length,
          sources: evidence.failed,
          units,
        };
      }
      // A deferred day (a quarter-hour photo, a travel day) gets no units; it is never replaced by a guess.
      const deferred = new Set(zones.deferred);
      const ranges: Window[] = [];
      for (const day of unitDays(month).filter((d) => !deferred.has(d))) {
        const last = ranges.at(-1);
        if (last && daysBefore(day, 1) === last.to) {
          last.to = day;
        } else {
          ranges.push({ from: day, to: day });
        }
      }
      const publications = ranges.map((range) => {
        const collected = {
          ...evidence,
          built: evidence.built.filter(
            (b) => b.unit.date >= range.from && b.unit.date <= range.to
          ),
          events: evidence.events.filter((e) => {
            const date = localDate(e.at);
            return date >= range.from && date <= range.to;
          }),
          window: range,
        };
        const prepared = preparePassages(
          collected.events,
          range,
          collected.skipped,
          undefined,
          undefined,
          deferred
        );
        const expanded =
          prepared.window.from < window.from || prepared.window.to > window.to
            ? readZones(prepared.window)
            : zones;
        if (expanded !== zones) {
          zones.deferred = [
            ...new Set([...zones.deferred, ...expanded.deferred]),
          ].sort();
          zones.gaps = [...new Set([...zones.gaps, ...expanded.gaps])].sort();
        }
        const excluded = new Set([...deferred, ...expanded.deferred]);
        return { collected, passages: () => prepared(excluded) };
      });
      for (const { collected, passages } of publications) {
        // biome-ignore lint/performance/noAwaitInLoops: all source reads succeeded before this month's first publication
        await publishUnits(collected, passages);
        hasPublished = true;
      }
      const added = evidence.built.filter(
        (b) => !deferred.has(b.unit.date)
      ).length;
      units += added;
      coverage.push({ ...month, skipped: evidence.skipped, units: added });
    }
  } finally {
    // readStaleness ignores units; completed months remain fetchable even when a later month fails.
    if (hasPublished) {
      await reindex();
    }
  }
  return {
    coverage,
    deferred: zones.deferred,
    failed: 0,
    gaps: zones.gaps,
    months: coverage.length,
    units,
  };
}
