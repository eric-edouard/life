import { MIN, minutes } from "../core/clock";
import type { QuantityKind, SourceEvent } from "../records/source";
import { quantityText } from "../sources/apple-health";
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

/** A measurement-day's totals, then sleep, workouts and weight; each night counts on its wake day. */
export function measurementDayText(list: SourceEvent[]) {
  const sorted = list.toSorted((a, b) => a.at.localeCompare(b.at));
  const sum = (ns: number[]) => ns.reduce((n, v) => n + v, 0);
  const total = (kind: QuantityKind, fold: (ns: number[]) => number) => {
    const values = sorted.flatMap((e) =>
      e.measured?.kind === kind ? [e.measured.value] : []
    );
    return values.length ? quantityText(kind, fold(values)) : "";
  };
  const mean = (ns: number[]) => sum(ns) / ns.length;
  const stepText = total("steps", sum);
  const totals = [
    stepText,
    total("resting_heart_rate", mean),
    total("heart_rate_variability", mean),
  ].filter(Boolean);
  const lines = sorted.filter(
    (e) =>
      !e.measured ||
      e.measured.kind === "sleep" ||
      e.measured.kind === "workout" ||
      e.measured.kind === "weight"
  );
  const asleep = sorted.flatMap((e) =>
    e.measured?.kind === "sleep" ? [e.measured.asleepMs] : []
  );
  const workouts = sorted.filter((e) => e.measured?.kind === "workout");
  const headline =
    [
      asleep.length ? `slept ${minutes(sum(asleep))}` : "",
      stepText,
      ...[
        ...Map.groupBy(workouts, (e) =>
          e.measured?.kind === "workout" ? e.measured.activity : ""
        ),
      ].map(
        ([activity, events]) =>
          `${activity.replaceAll("_", " ")} ${minutes(sum(events.map((e) => Date.parse(e.until ?? e.at) - Date.parse(e.at))))}`
      ),
    ]
      .filter(Boolean)
      .join(", ") ||
    totals.join(", ") ||
    (lines.at(-1) as SourceEvent).text;
  const body = [
    ...(totals.length ? [`Totals: ${totals.join(", ")}`] : []),
    ...lines.map(
      (e) => `${time(e.at)}${e.until ? `–${time(e.until)}` : ""} ${e.text}`
    ),
  ].join("\n");
  return { body, headline, lines };
}
