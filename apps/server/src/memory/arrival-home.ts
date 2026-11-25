import { DAY } from "../core/clock";
import { distanceM } from "../core/distance";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { visits, whereAt } from "../sources/lifelog";
import { lifelogMissing } from "../sources/lifelog-call";
import { readMatterPins } from "./matters";
import { recordCorrection } from "./memory-files";
import { dayNow, dayStart } from "./zones";

// His Later "when I'm home" (v4.1, bundle H): a `later` instruction naming home holds a check 24 hours (`laterOf`), and
// his next arrival home ends it sooner: Life appends one `deferred` line until now, the latest for a ref winning.

/** Whether a `later` instruction's words name home ("when I'm home", "back home"). Pure. */
export const isHomeLaterOf = (text: string) => /\bhome\b/i.test(text);

/** How long a Later that waits for home holds at most. */
export const HOME_LATER_FOR = DAY;

/** How near an arrival counts as home. */
const HOME_WITHIN_M = 150;

/**
 * Where he slept: his stay at the last 4:00 where he is. ponytail: last night's place stands for home, so a hotel is
 * "home" while he travels; a home of his directory's address once places carry one.
 */
async function homeOf(now: Date) {
  const today = dayStart(dayNow(now), undefined, "04:00");
  const at =
    today.getTime() <= now.getTime() ? today : new Date(today.getTime() - DAY);
  const [stay] = await whereAt(at.toISOString());
  return stay;
}

/**
 * Ends each Later in force that waits for home once he arrived home after it was written (`deferredHome`): one `deferred`
 * line until `now` per check, written by Life. Never throws: lifelog unreadable leaves them to their 24 hours.
 */
export async function endLatersAtHome(now: Date) {
  const pins = readMatterPins();
  const waiting = [...pins.deferredHome].filter(
    ([ref]) => Date.parse(pins.deferred.get(ref) ?? "") > now.getTime()
  );
  if (waiting.length === 0 || lifelogMissing()) {
    return 0;
  }
  try {
    const home = await homeOf(now);
    if (!home) {
      return 0;
    }
    const since = waiting.map(([, at]) => at).toSorted()[0] ?? "";
    const arrivals = (await visits({ from: since }))
      .filter((s) => distanceM(s, home) <= HOME_WITHIN_M)
      .map((s) => s.arrivedAt);
    const ended = waiting.filter(([, at]) =>
      arrivals.some((a) => Date.parse(a) > Date.parse(at))
    );
    for (const [ref] of ended) {
      // biome-ignore lint/performance/noAwaitInLoops: one line each, in order
      await recordCorrection({
        kind: "deferred",
        note: "arrived home",
        ref,
        until: now.toISOString(),
      });
    }
    return ended.length;
  } catch (e) {
    log("run.error", { ...errorOf(e), step: "later.home" });
    return 0;
  }
}
