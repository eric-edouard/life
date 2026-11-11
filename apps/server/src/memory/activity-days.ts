import { MIN, minutes } from "../core/clock";
import type { SourceEvent } from "../records/source";
import { WEB } from "../sources/screen";
import { time } from "./zones";

/** A device-day's stints this long are its lines; shorter ones count in its totals only. */
const LINE_STINT = 5 * MIN;

/** A device-day's time by app and website, then stints of 5 minutes or more; its headline counts app time. */
export function deviceDayText(list: SourceEvent[]) {
  const sorted = list.toSorted((a, b) => a.at.localeCompare(b.at));
  const length = (e: SourceEvent) =>
    Date.parse(e.until ?? e.at) - Date.parse(e.at);
  const lines = sorted.filter((e) => length(e) >= LINE_STINT);
  const totals = [...Map.groupBy(sorted, (e) => e.text)]
    .map(([what, l]) => ({ ms: l.reduce((n, e) => n + length(e), 0), what }))
    .filter((t) => t.ms >= MIN)
    .sort((a, b) => b.ms - a.ms);
  const apps = totals.filter((t) => !t.what.startsWith(WEB));
  const [top] = apps;
  const body = [
    `Time: ${totals.map((t) => `${t.what} ${minutes(t.ms)}`).join(", ")}`,
    ...lines.map((e) => `${time(e.at)}–${time(e.until ?? e.at)} ${e.text}`),
  ].join("\n");
  const headline = `${minutes(apps.reduce((n, t) => n + t.ms, 0))} in apps${top ? `, most ${top.what} ${minutes(top.ms)}` : ""}`;
  return { body, headline, lines };
}

/** A measurement-day's nights and workouts, each with its own start and end. */
export function measurementDayText(list: SourceEvent[]) {
  const lines = list.toSorted((a, b) => a.at.localeCompare(b.at));
  const body = lines
    .map((e) => `${time(e.at)}–${time(e.until ?? e.at)} ${e.text}`)
    .join("\n");
  return { body, headline: lines.map((e) => e.text).join(", "), lines };
}
