import { clock, iso, MIN } from "../core/clock";
import { settings } from "../core/settings";
import { localTime, time } from "../memory/zones";
import { readCalendarEvents } from "../sources/google-calendar-events";
import { lifelogStatus, newestTurn, whereAt } from "../sources/voice-server";
import { lifelogMissing } from "../sources/voice-server-call";
import { readDesk } from "./desk-read";

// What he is doing now, in place of fixed quiet hours (the v4 plan, verdict 12): one line from the signals Life has,
// for wherever Life chooses a moment (the gate first). Each signal read on its own; one that can't be read is left out,
// never guessed. iOS's own Focus holds an ordinary push, so the phone's Focus is the one signal for sleep and driving.

/** A phone's report older than this says nothing about now (the Mac's check-in wakes it every 15 minutes). */
const PHONE_FRESH = 20 * MIN;
/** Speech the pendant heard this recently: he is talking with someone. */
const TALKING_WITHIN = 5 * MIN;
/** A stay that began this recently: he has just arrived. */
const ARRIVED_WITHIN = 15 * MIN;
/** His last ask of Life this recently: Life's app is open in his hand, so now is free. */
const APP_OPEN_WITHIN = 2 * MIN;
/** One signal waits this long at most: the gate has 10 seconds in all. */
const SIGNAL_MS = 4000;

const within = <T>(p: Promise<T>) =>
  Promise.race([
    p,
    Bun.sleep(SIGNAL_MS).then(() => {
      throw new Error("late");
    }),
  ]);

/** A calendar event under way now, from his calendar Life is given (`appointmentsCalendar`), Life's own left out. */
async function calendarLine(now: Date) {
  const cal = settings().appointmentsCalendar;
  if (!cal) {
    return null;
  }
  const events = await readCalendarEvents(
    cal.calendar,
    cal.account,
    now.toISOString(),
    iso(now.getTime() + MIN)
  );
  const on = events.find(
    (e) =>
      e.start?.dateTime &&
      e.end?.dateTime &&
      e.extendedProperties?.private?.lifeOutput === undefined
  );
  return on?.end?.dateTime
    ? `in a calendar event until ${time(iso(Date.parse(on.end.dateTime)))}`
    : null;
}

/** The phone's last report, when fresh: a Focus on, a call connected. */
async function phoneLines(now: Date) {
  const beat = (await lifelogStatus()).phoneHeartbeat;
  if (
    !beat?.observedAt ||
    now.getTime() - Date.parse(beat.observedAt) > PHONE_FRESH
  ) {
    return [];
  }
  return [
    ...(beat.focus
      ? ["a Focus is on (asleep, driving or do not disturb)"]
      : []),
    ...(beat.onCall ? ["on a phone call"] : []),
  ];
}

/** Talking with someone: the pendant heard speech in the last minutes. */
async function talkingLine(now: Date) {
  const at = await newestTurn();
  return at && now.getTime() - Date.parse(at) <= TALKING_WITHIN
    ? `talking with someone (speech heard at ${time(at)})`
    : null;
}

/** Just arrived somewhere, or between places (no stay now). */
async function placeLine(now: Date) {
  const [stay] = await whereAt(now.toISOString());
  if (!stay) {
    return "between places";
  }
  return now.getTime() - Date.parse(stay.arrivedAt) <= ARRIVED_WITHIN
    ? `just arrived somewhere (${time(stay.arrivedAt)})`
    : null;
}

/** When he last asked Life from his phone (the newest thread entry), if within `APP_OPEN_WITHIN` of `now`; the desk off or unread, none. */
export function appOpenSinceOf(now = clock()) {
  const read = readDesk(
    (db) =>
      db
        .query<{ at: string | null }, []>(
          "select max(asked_at) as at from thread_entry"
        )
        .get()?.at ?? null,
    null
  );
  const at = read.state === "ok" ? read.value : null;
  return at && now.getTime() - Date.parse(at) <= APP_OPEN_WITHIN
    ? at
    : undefined;
}

/**
 * What he is doing now, as one line for a model: the local time where he is, Life's app open (`appOpenSinceOf`: free),
 * then each signal that holds (a calendar event, a Focus, a call, talking, just arrived or between places). Never throws: a signal that fails is left out.
 */
export async function ownerStateNow(now = clock()) {
  const isVoice = !lifelogMissing();
  const read = await Promise.allSettled([
    within(calendarLine(now)),
    isVoice ? within(phoneLines(now)) : Promise.resolve([]),
    isVoice ? within(talkingLine(now)) : Promise.resolve(null),
    isVoice ? within(placeLine(now)) : Promise.resolve(null),
  ]);
  const signals = read.flatMap((r) =>
    r.status === "fulfilled" && r.value ? [r.value].flat() : []
  );
  const open = appOpenSinceOf(now);
  return [
    `local time ${localTime(now.toISOString())}`,
    ...(open
      ? [`has Life's app open (asked Life at ${time(open)}): free`]
      : []),
    ...signals,
  ].join("; ");
}
