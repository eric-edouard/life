import { DAY } from "../core/clock";
import { distanceM } from "../core/distance";
import { writeJson } from "../core/files";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { visits, whereAt } from "../sources/lifelog";
import { lifelogMissing } from "../sources/lifelog-call";
import { readMatterPins } from "./matters";
import { HOME_ARRIVAL, readHomeArrival } from "./memory-files";
import { dayNow, dayStart } from "./zones";

// His Later "when I'm home" (v4.1, bundle H): a `later` instruction naming home holds a check 24 hours (`laterOf`), and
// his next arrival home ends it sooner, worked out when read (`laterUntilOf`) from the last arrival home the desk saw.

/** A `later` instruction that waits for home, as written ("when I'm home", "once I get back home", "at home"), never a negated one. */
const HOME =
  /(?<!\bnot\s)\b(?:(?:when|once|until|till)\s+I(?:'m|\s+am|\s+get|\s+got|\s+arrive)(?:\s+back)?\s+home|at\s+home)\b/i;
/** Whether a `later` instruction's words ask to wait until he is home. Pure. */
export const isHomeLaterOf = (text: string) => HOME.test(text);

/** How long a Later that waits for home holds at most. */
export const HOME_LATER_FOR = DAY;

/** How near an arrival counts as home. */
const HOME_WITHIN_M = 150;

/**
 * Where he slept: his stay at the last 4:00 where he is. ponytail: his directory holds no home address (Contacts' is
 * text, with no point to compare stays with), so last night's place stands for home and a hotel is "home" while he
 * travels; his home's point once his directory carries one.
 */
async function homeOf(now: Date) {
  const today = dayStart(dayNow(now), undefined, "04:00");
  const at =
    today.getTime() <= now.getTime() ? today : new Date(today.getTime() - DAY);
  const [stay] = await whereAt(at.toISOString());
  return stay;
}

/**
 * While a Later waits for home (`deferredHome`, in force), keeps his newest arrival home since it in Life's state
 * (`HOME_ARRIVAL`), never his data; nothing of his is written. Never throws: lifelog unreadable leaves them to their 24 hours.
 */
export async function recordArrivalHome(now: Date) {
  const pins = readMatterPins();
  const since = [...pins.deferredHome]
    .filter(([ref]) => Date.parse(pins.deferred.get(ref) ?? "") > now.getTime())
    .map(([, at]) => at)
    .toSorted()[0];
  if (!since || lifelogMissing()) {
    return;
  }
  try {
    const home = await homeOf(now);
    const last = home
      ? (await visits({ from: since }))
          .filter((s) => distanceM(s, home) <= HOME_WITHIN_M)
          .map((s) => s.arrivedAt)
          .toSorted()
          .at(-1)
      : undefined;
    if (last && last > (readHomeArrival() ?? "")) {
      writeJson(HOME_ARRIVAL, { at: last });
    }
  } catch (e) {
    log("run.error", { ...errorOf(e), step: "later.home" });
  }
}
