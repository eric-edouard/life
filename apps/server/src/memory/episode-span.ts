import { HOUR } from "../core/clock";
import type { Episode } from "../records/episode";
import { daysBefore } from "./units";
import { dayStart } from "./zones";

// When an episode was, as an event: the Past calendar's (past-events.ts) and the day's read (search.ts).

const instant = (local: string) => {
  const [day = "", hm] = local.split(" ");
  return dayStart(day, undefined, hm).toISOString();
};

/** When an episode was: its timed start to its end (an hour when the sources don't say), else whole days. */
export function span(m: Pick<Episode, "day" | "end" | "start">) {
  const start = m.start ?? m.day;
  if (!start.includes(" ")) {
    const last = (m.end ?? start).slice(0, 10);
    return {
      allDay: true,
      from: start,
      to: daysBefore(last > start ? last : start, -1),
    };
  }
  const from = instant(start);
  const end = m.end?.includes(" ") ? instant(m.end) : "";
  // ponytail: an hour when no end is known.
  const to = end > from ? end : new Date(Date.parse(from) + HOUR).toISOString();
  return { allDay: false, from, to };
}

/** An event's edge as an instant (ms): a day's start in his zone then, or the instant itself. */
export const edgeTime = (allDay: boolean, edge: string) =>
  (allDay ? dayStart(edge) : new Date(edge)).getTime();

/** When an episode's event ends, as an instant (ms). */
export const endOf = (m: Episode) => {
  const { allDay, to } = span(m);
  return edgeTime(allDay, to);
};
