import { MIN } from "../../core/clock";
import type { LogEvent } from "../../core/log";
import { ASK, type Card, firstOf } from "./card";

// The status card "Crashes": Life's helpers crashing (`main`'s catch, host/cli.ts, logs each as a `run.error` of step
// `crash`). Red on a crash loop now; amber after any crash in the day. Its word is "looping" after any crash loop in
// the day, so the tick's alert (`redCards`) mails a loop once a day even when it fell between two ticks.

type ErrorLine = Pick<LogEvent, "at" | "kind" | "step"> & {
  command?: unknown;
  error?: unknown;
};

/** A helper's crash: its log line, for the card and its history (`snapshot-detail.ts`). */
export const isCrash = (e: ErrorLine) =>
  e.kind === "run.error" && e.step === "crash";
/** This many crashes within half an hour (the nightly tick's beat) are a crash loop. */
const CRASH_LOOP_AT = 5;
const CRASH_LOOP_MS = 30 * MIN;
const LOOPING = "looping";

/** The crashes of the latest crash loop among `crashes` (oldest first): its window ends at its last crash. */
function latestLoopOf<T extends ErrorLine>(crashes: T[]): T[] {
  let [from, to, start] = [0, 0, 0];
  crashes.forEach((last, i) => {
    while (
      Date.parse(last.at) - Date.parse(crashes[start]?.at ?? "") >=
      CRASH_LOOP_MS
    ) {
      start += 1;
    }
    if (i + 1 - start >= CRASH_LOOP_AT) {
      [from, to] = [start, i + 1];
    }
  });
  return crashes.slice(from, to);
}

/** The crash card after a crash loop in the day, red or not: the alert mails it (`redCards`). */
export const isCrashLoopCard = (c: Card) =>
  c.id === "crashes" && c.word === LOOPING;

/** The card from the run errors of the last day (`errorsToday`), oldest first, at `now`. */
export function crashCard(errors: ErrorLine[], now: number): Card {
  const crashes = errors.filter(isCrash);
  const recent = crashes.filter((e) => now - Date.parse(e.at) < CRASH_LOOP_MS);
  const loop = recent.length >= CRASH_LOOP_AT ? recent : latestLoopOf(crashes);
  const commands = [...new Set(loop.map((e) => String(e.command)))].join(", ");
  const last = crashes.at(-1);
  return {
    ...firstOf(
      [
        loop === recent,
        {
          ask: ASK(`${commands} crashing over and over`),
          tone: "bad",
          word: LOOPING,
        },
      ],
      [loop.length > 0, { tone: "warn", word: LOOPING }],
      [
        last !== undefined,
        { tone: "warn", word: `${crashes.length} in a day` },
      ],
      [true, { tone: "ok", word: "none" }]
    ),
    at: loop.at(-1)?.at ?? last?.at ?? null,
    content: last ? [`Error: ${String(last.error)}`] : undefined,
    facts: [
      { label: "Last 30 min", value: String(recent.length) },
      { label: "Last day", value: String(crashes.length) },
      { at: last?.at ?? null, label: "Last crash" },
    ],
    group: "capture",
    headline:
      loop.length > 0
        ? `${commands} crashed ${loop.length} times in 30 min`
        : `${crashes.length} crashes in a day`,
    id: "crashes",
    name: "Crashes",
  };
}
