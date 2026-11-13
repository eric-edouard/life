import { clock, daysBefore } from "../core/clock";
import { filesIn } from "../core/files";
import { readEvidence, readHistoricalZones } from "./historical-zones";
import { UNITS } from "./memory-files";
import { preparePassages } from "./passages";
import { type Tables, tables } from "./sources";
import { dayNow, dayStart, isDay, monthsOf, type Window } from "./zones";

/** Explicit model-free passage rebuilding, one month per transaction; repeating completed months is safe. */
export async function rebuildPassages(
  requested: { from?: string; to?: string } = {},
  read: {
    sources: () => Partial<Tables["SEARCHED"]>;
    zones?: (window: Window) => { deferred: string[] };
  } = {
    sources: () => ({ ...tables().SEARCHED, ...tables().SEARCHED_MAIL }),
  }
) {
  // The evidence of the zones is the same for every month: read it once.
  let evidence: ReturnType<typeof readEvidence> | undefined;
  const zonesOf =
    read.zones ??
    ((window: Window) =>
      readHistoricalZones(window, () => {
        evidence ??= readEvidence();
        return evidence;
      }));
  const from = requested.from ?? (await filesIn(UNITS)).sort()[0]?.slice(0, 10);
  const to = requested.to ?? dayNow();
  if (!from) {
    return { failed: 0, messages: 0, months: 0 };
  }
  if (!(isDay(from) && isDay(to) && from <= to && to <= dayNow())) {
    throw new Error(
      "passages needs an ordered --from/--to range ending no later than today"
    );
  }
  let months = 0;
  let messages = 0;
  for (const window of monthsOf({ from, to })) {
    const readers = read.sources();
    const start = dayStart(window.from);
    const end = new Date(
      Math.min(dayStart(daysBefore(window.to, -1)).getTime(), clock().getTime())
    );
    try {
      const events = Object.values(readers).flatMap(
        (sourceRead) => sourceRead?.(start, end) ?? []
      );
      const publish = preparePassages(events, window, [], readers);
      const zones = zonesOf(publish.window);
      publish(new Set(zones.deferred));
      messages += events.length;
      months += 1;
    } catch (error) {
      return {
        error: (error as Error).message,
        failed: 1,
        messages,
        months,
        retry: window.from,
      };
    }
  }
  return { failed: 0, messages, months };
}
