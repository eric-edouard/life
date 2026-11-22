import { DAY, iso, MIN, minutes } from "../core/clock";
import { digest } from "../core/hash";
import type { SourceEvent } from "../records/source";
import { readScreen, WEB } from "../sources/screen";
import type { Draft } from "./calendar-events";
import { dayStart, localDate, time } from "./zones";

// Screen blocks in the Past calendar (his yes, 22 Nov 2026): per device-day, the stints (`readScreen`, `deviceDayText`'s
// source) joined into blocks, each an event "Mac · Claude, Chrome, Xcode", free like every Past event. Model-free. A
// block's `of` is `screen:<device>/<its start>`, so it never meets an episode's id; the nightly's line is `screenLine`.

/** Stints less than this apart are one block. */
const JOIN = 15 * MIN;
/** How many apps a block names. */
const TOP_APPS = 3;
/** The days (local, back from the sync's `since`) read each time: never more, at any age of the archive. */
const WINDOW = 3 * DAY;
/** The description's layout, in the hash. */
const LAYOUT = 1;
export const SCREEN_OF = "screen:";

// ponytail: bundle ids to names by a small map, else the id's last part; the app's own display name (mdfind) when this
// turns out to name too many apps wrongly.
const NAMES: Record<string, string> = {
  "com.anthropic.claudefordesktop": "Claude",
  "com.apple.dt.Xcode": "Xcode",
  "com.apple.iChat": "Messages",
  "com.apple.MobileSMS": "Messages",
  "com.apple.mail": "Mail",
  "com.apple.mobilesafari": "Safari",
  "com.apple.Notes": "Notes",
  "com.apple.Safari": "Safari",
  "com.apple.Terminal": "Terminal",
  "com.google.Chrome": "Chrome",
  "com.microsoft.VSCode": "VS Code",
  "com.openai.chat": "ChatGPT",
  "com.tinyspeck.slackmacgap": "Slack",
  "net.whatsapp.WhatsApp": "WhatsApp",
  "net.whatsapp.WhatsApp.iOS": "WhatsApp",
};
export const appNameOf = (bundle: string) =>
  NAMES[bundle] ?? bundle.split(".").at(-1) ?? bundle;

const length = (e: SourceEvent) =>
  Date.parse(e.until ?? e.at) - Date.parse(e.at);

/** One device's stints of one local day, each list in time order. */
const deviceDays = (events: SourceEvent[]) => [
  ...Map.groupBy(
    events.toSorted((a, b) => a.at.localeCompare(b.at)),
    (e) => `${e.chat}|${localDate(e.at)}`
  ).values(),
];

/** The apps of `list` by time in front, most first (websites are inside Safari's or Chrome's time). */
const appsOf = (list: SourceEvent[]) =>
  [
    ...Map.groupBy(
      list.filter((e) => !e.text.startsWith(WEB)),
      (e) => appNameOf(e.text)
    ),
  ]
    .map(([name, l]) => ({ ms: l.reduce((n, e) => n + length(e), 0), name }))
    .sort((a, b) => b.ms - a.ms);

/** The blocks of a device-day's stints: joined while the next begins within `JOIN` of the last one's end. */
function blocksOf(day: SourceEvent[]) {
  const blocks: { from: string; stints: SourceEvent[]; to: string }[] = [];
  for (const e of day) {
    const b = blocks.at(-1);
    const until = e.until ?? e.at;
    if (b && Date.parse(e.at) - Date.parse(b.to) < JOIN) {
      b.stints.push(e);
      b.to = until > b.to ? until : b.to;
    } else {
      blocks.push({ from: e.at, stints: [e], to: until });
    }
  }
  return blocks;
}

/** The Past calendar's screen blocks of `events`: free, each named by its device and top apps. */
export function screenDrafts(events: SourceEvent[]): Draft[] {
  return deviceDays(events).flatMap((day) =>
    blocksOf(day).map((b) => {
      const apps = appsOf(b.stints);
      const draft = {
        allDay: false,
        from: b.from,
        of: `${SCREEN_OF}${b.stints[0]?.chat}/${b.from}`,
        place: null,
        summary: [
          b.stints[0]?.chatName ?? "Device",
          apps
            .slice(0, TOP_APPS)
            .map((a) => a.name)
            .join(", "),
        ]
          .filter(Boolean)
          .join(" · "),
        text: [
          ...apps.map((a) => `${a.name} ${minutes(a.ms)}`),
          "",
          "Screen Time, written by Life.",
        ].join("\n"),
        to: b.to,
      };
      return {
        ...draft,
        hash: digest("sha1", JSON.stringify([LAYOUT, draft]), 12),
      };
    })
  );
}

/**
 * The first instant of the days a sync reads: the local day `WINDOW` before `since` (the sync's own, else `now`). Screen
 * blocks before it are left as they are.
 */
export const screenWindowStart = (since: Date | undefined, now: Date) =>
  dayStart(localDate(iso((since ?? now).getTime() - WINDOW))).toISOString();

/** The screen blocks wanted since `windowStart`: only those days' stints are read, whatever the archive's age. */
export const wantedScreen = (windowStart: string) =>
  screenDrafts(readScreen(new Date(windowStart)));

/** "6 h 10", "40 min". */
const hm = (ms: number) => {
  const m = Math.round(ms / MIN);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60}`;
};

/** The nightly's line for a day's stints: "Mac 6 h 10 (09:05–23:40), iOS device 2 h 20"; empty with none. */
export const screenLine = (events: SourceEvent[]) =>
  [...Map.groupBy(events, (e) => e.chat).values()]
    .map((list) => {
      const apps = list.filter((e) => !e.text.startsWith(WEB));
      return {
        apps,
        ms: apps.reduce((n, e) => n + length(e), 0),
      };
    })
    .filter((d) => d.apps.length > 0)
    .sort((a, b) => b.ms - a.ms)
    .map(({ apps, ms }) => {
      const first = apps.reduce(
        (a, e) => (e.at < a ? e.at : a),
        apps[0]?.at ?? ""
      );
      const last = apps.reduce(
        (a, e) => ((e.until ?? e.at) > a ? (e.until ?? e.at) : a),
        ""
      );
      return `${apps[0]?.chatName ?? "Device"} ${hm(ms)} (${time(first)}–${time(last)})`;
    })
    .join(", ");
