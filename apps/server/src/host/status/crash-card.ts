import { MIN } from "../../core/clock";
import { ASK, type Card, firstOf } from "./card";

// The status card "Crashes": Life's helpers crashing (`main`'s catch, host/cli.ts, logs each as a `run.error` of step
// `crash`). Red on a crash loop, so the tick's alert mails it once a day (`redCards`); amber after any crash in the day.

interface ErrorLine {
  at: string;
  command?: unknown;
  error?: unknown;
  kind: string;
  step?: unknown;
}

/** A helper's crash: its log line, for the card and its history (`snapshot-detail.ts`). */
export const isCrash = (e: ErrorLine) =>
  e.kind === "run.error" && e.step === "crash";
/** Crashes at or past this in the last half hour (the nightly tick's beat) are a crash loop. */
const CRASH_LOOP_AT = 5;
const CRASH_LOOP_MS = 30 * MIN;

/** The card from the run errors of the last day (`errorsToday`), oldest first, at `now`. */
export function crashCard(errors: ErrorLine[], now: number): Card {
  const crashes = errors.filter(isCrash);
  const recent = crashes.filter((e) => now - Date.parse(e.at) < CRASH_LOOP_MS);
  const looping = recent.length >= CRASH_LOOP_AT;
  const commands = [...new Set(recent.map((e) => String(e.command)))].join(
    ", "
  );
  const last = crashes.at(-1);
  return {
    ...firstOf(
      [
        looping,
        {
          ask: ASK(`${commands} crashing over and over`),
          tone: "bad",
          word: "looping",
        },
      ],
      [
        last !== undefined,
        { tone: "warn", word: `${crashes.length} in a day` },
      ],
      [true, { tone: "ok", word: "none" }]
    ),
    at: last?.at ?? null,
    content: last ? [`Error: ${String(last.error)}`] : undefined,
    facts: [
      { label: "Last 30 min", value: String(recent.length) },
      { label: "Last day", value: String(crashes.length) },
      { at: last?.at ?? null, label: "Last crash" },
    ],
    group: "capture",
    headline: looping
      ? `${commands} crashed ${recent.length} times in 30 min`
      : `${crashes.length} crashes in a day`,
    id: "crashes",
    name: "Crashes",
  };
}
