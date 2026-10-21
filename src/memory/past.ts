import { clock, unfrozen } from "../clock";
import { log } from "../log";
import { exec } from "../proc";
import { redact } from "../redact";
import type { Moment, Unit } from "../schema";
import {
  conversationsBetween,
  type Stay,
  whereAt,
  withStore,
} from "../sources/lifelog";
import { digest, momentsNow, readMoments, readUnits } from "./ledger";
import { where } from "./places";
import { momentText } from "./statements";
import { clip, daysBefore, time } from "./units";
import { observationsNow, readPeople } from "./who";
import { dayStart, localDate } from "./zones";

// The Past calendar (his request, 21 Oct): every moment that happened, as an event in his Google calendar
// `LIFE_PAST_CALENDAR` (of the account `LIFE_PAST_ACCOUNT`, through `gog`), with who, where he was (lifelog's stays),
// the conversations recorded, what Life noted and every unit it was read from. A one-way projection of the moments,
// like the board: each event carries its moment's id and a hash of what it shows (private properties), a moment that
// changed is written again, one gone (hidden, cancelled, never happened) is deleted. Nothing is read back. Each
// nightly tick runs it after its turn.

const HOUR = 3_600_000;
// ponytail: a moment goes on the calendar 2 h after it ends, so lifelog has its stays: they are read once, when it
// is written, and are not in its hash. Hash them (a read per moment each tick) if late stays turn out to matter.
const SETTLE = 2 * HOUR;
// Google takes 8,192 characters; a busy moment's units would pass it.
const DESCRIPTION_MAX = 7500;

/** One moment as an event, before the IO-bound part (stays and conversations, added only when it is written). */
export interface Draft {
  allDay: boolean;
  /** RFC3339 instants, or YYYY-MM-DD days (end exclusive) when `allDay`. */
  from: string;
  hash: string;
  moment: string;
  place: string | null;
  summary: string;
  text: string;
  to: string;
}

interface Known {
  nameOf: (ref: string) => string;
  /** What Life noted, by unit: the observations that show. */
  noted: Map<string, string[]>;
  units: Map<string, Unit>;
}

const nextDay = (day: string) => daysBefore(day, -1);
const instant = (local: string) => {
  const [day = "", hm] = local.split(" ");
  return dayStart(day, undefined, hm).toISOString();
};
/** An event's edge as an instant: a day's start in his zone then, or the instant itself. */
const at = (allDay: boolean, edge: string) =>
  (allDay ? dayStart(edge) : new Date(edge)).getTime();

/** When a moment was: its timed start to its end (an hour when the sources don't say), else whole days. */
function span(m: Moment) {
  const start = m.start ?? m.day;
  if (!start.includes(" ")) {
    const last = (m.end ?? start).slice(0, 10);
    return {
      allDay: true,
      from: start,
      to: nextDay(last > start ? last : start),
    };
  }
  const from = instant(start);
  const end = m.end?.includes(" ") ? instant(m.end) : "";
  // ponytail: an hour when no end is known; the units' last instant would be closer.
  const to = end > from ? end : new Date(Date.parse(from) + HOUR).toISOString();
  return { allDay: false, from, to };
}

/**
 * Moments never overlap on the calendar (his rule, 21 Oct): of the timed and multi-day ones, one that covers another (a
 * stay, a trip) is left off, and one that runs into the next ends where it starts (a multi-day one is never cut). A
 * single whole day sits in the calendar's all-day band, over no one, so it always stays.
 */
export function tiled<T extends { allDay: boolean; from: string; to: string }>(
  spans: T[]
) {
  const band = (x: T) => x.allDay && x.to === nextDay(x.from);
  const ms = spans
    .filter((x) => !band(x))
    .map((x) => ({ e: at(x.allDay, x.to), s: at(x.allDay, x.from), x }));
  const kept = ms
    .filter(
      (a) =>
        !ms.some(
          (b) => b !== a && a.s <= b.s && b.e <= a.e && b.e - b.s < a.e - a.s
        )
    )
    .toSorted((a, b) => a.s - b.s || b.e - a.e);
  return [
    ...spans.filter(band),
    ...kept.flatMap((a, i) => {
      const next = kept[i + 1];
      if (a.x.allDay || !next || next.s >= a.e) {
        return [a.x];
      }
      // Two moments over the same span: the later one in the list stays.
      return next.s > a.s
        ? [{ ...a.x, to: new Date(next.s).toISOString() }]
        : [];
    }),
  ];
}

/** The events the calendar should hold: every moment that happened and ended (`SETTLE` ago) by `now`, none overlapping. */
export function drafts(moments: Moment[], k: Known, now: Date): Draft[] {
  return tiled(
    moments
      .filter((m) => m.status === "happened")
      .map((m) => ({ m, ...span(m) }))
  )
    .filter(({ allDay, to }) => at(allDay, to) + SETTLE <= now.getTime())
    .map(({ m, ...when }) => {
      const units = m.units.flatMap((id) => k.units.get(id) ?? []);
      const noted = [
        ...new Set(m.units.flatMap((id) => k.noted.get(id) ?? [])),
      ];
      const text = [
        m.why,
        "",
        momentText(m, k.nameOf),
        ...(noted.length > 0
          ? ["", "What Life noted:", ...noted.map((t) => `- ${t}`)]
          : []),
        "",
        `Read from ${units.length} unit${units.length === 1 ? "" : "s"}:`,
        ...units
          .toSorted((a, b) => a.start.localeCompare(b.start))
          .map(
            (u) =>
              `- ${u.date} ${time(u.start)} ${u.source} · ${clip(u.title, 100)}${u.summary ? `: ${clip(u.summary, 200)}` : ""}`
          ),
      ].join("\n");
      const draft = {
        ...when,
        moment: m.id,
        place: m.place,
        summary: m.title,
        text,
      };
      return { ...draft, hash: digest("sha1", JSON.stringify(draft), 12) };
    });
}

type Held = Map<string, { hash?: string; id: string }[]>;

/** What a sync does: the events to delete (of a moment gone or changed, and any second copy) and the drafts to write. */
export function plan(want: Draft[], held: Held) {
  const keep = new Set(
    want.flatMap((d) => {
      const [e, ...more] = held.get(d.moment) ?? [];
      return e?.hash === d.hash && more.length === 0 ? [d.moment] : [];
    })
  );
  return {
    fresh: want.filter((d) => !keep.has(d.moment)),
    stale: [...held].flatMap(([moment, events]) =>
      keep.has(moment) ? [] : events.map((e) => ({ id: e.id, moment }))
    ),
  };
}

/** The days a timed event spans, in his zone then. */
function daysOf(d: Draft) {
  const days = [localDate(d.from)];
  while ((days.at(-1) as string) < localDate(d.to)) {
    days.push(nextDay(days.at(-1) as string));
  }
  return days;
}

/** A timed event's stays (read when it is written) and conversations, as description lines and a location. */
async function located(
  d: Draft,
  talks: { id: string; start_at: string; title: string }[],
  staysOn: (day: string) => Promise<Stay[]>
) {
  const stays = (await Promise.all(daysOf(d).map(staysOn)))
    .flat()
    .filter((s) => s.arrivedAt < d.to && (s.leftAt ?? d.to) > d.from)
    .toSorted((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));
  const length = (s: Stay) =>
    Date.parse(s.leftAt ?? d.to) - Date.parse(s.arrivedAt);
  const longest = stays.reduce<Stay | undefined>(
    (a, s) => (a && length(a) >= length(s) ? a : s),
    undefined
  );
  return {
    lines: [
      ...(stays.length > 0
        ? [
            "",
            "Where he was (lifelog):",
            ...stays.map(
              (s) =>
                `- ${time(s.arrivedAt)}–${s.leftAt ? time(s.leftAt) : "…"} ${where(s)} https://maps.google.com/?q=${s.latitude},${s.longitude}`
            ),
          ]
        : []),
      ...(talks.length > 0
        ? [
            "",
            "Conversations recorded:",
            ...talks.map((c) => `- ${time(c.start_at)} ${c.title} (${c.id})`),
          ]
        : []),
    ],
    location: d.place ?? (longest ? where(longest) : null),
  };
}

const PastEvents = (stdout: string) =>
  JSON.parse(stdout) as {
    events?: {
      extendedProperties?: { private?: Record<string, string> };
      id: string;
    }[];
    nextPageToken?: string;
  };

/** The drafts of every moment as memory holds it now. */
async function wanted(now: Date) {
  const people = await readPeople();
  const [{ observations }, units, moments] = await Promise.all([
    observationsNow(people),
    readUnits(),
    readMoments(),
  ]);
  return drafts(
    momentsNow(moments, people.corrections),
    {
      nameOf: people.nameOf,
      noted: new Map(
        [...Map.groupBy(observations, (o) => o.unit)].map(([u, os]) => [
          u,
          os.map((o) => o.text),
        ])
      ),
      units: new Map(units.map((u) => [u.id, u])),
    },
    now
  );
}

/** The Past calendar through `gog`: what it holds of Life's (events with a moment id, by moment), and its writes. */
function pastCalendar(calendar: string, account: string) {
  // Values go as `--flag=value`: a model-written title starting with "-" must not read as a flag.
  const run = async (args: string[]) => {
    unfrozen("use his calendar");
    const r = await exec([
      "gog",
      "calendar",
      ...args,
      `--account=${account}`,
      "--json",
      "--no-input",
    ]);
    if (r.code !== 0) {
      throw new Error(`gog ${args[0]}: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r.stdout;
  };
  return {
    async held(until: string) {
      const held: Held = new Map();
      let page = "";
      do {
        const r = PastEvents(
          // biome-ignore lint/performance/noAwaitInLoops: pages follow one another
          await run([
            "events",
            calendar,
            "--from=2000-01-01",
            `--to=${until}`,
            "--max=2500",
            ...(page ? [`--page=${page}`] : []),
          ])
        );
        for (const e of r.events ?? []) {
          const p = e.extendedProperties?.private;
          if (p?.lifeMoment) {
            held.set(p.lifeMoment, [
              ...(held.get(p.lifeMoment) ?? []),
              { hash: p.lifeHash, id: e.id },
            ]);
          }
        }
        page = r.nextPageToken ?? "";
      } while (page);
      return held;
    },
    async remove(moment: string, id: string) {
      await run(["delete", calendar, id, "--force"]);
      log("calendar.write", { event: id, moment, op: "delete" });
    },
    async write(d: Draft, description: string, location: string | null) {
      const out = await run([
        "create",
        calendar,
        `--summary=${redact(d.summary)}`,
        `--from=${d.from}`,
        `--to=${d.to}`,
        ...(d.allDay ? ["--all-day"] : []),
        `--description=${description}`,
        ...(location ? [`--location=${redact(location)}`] : []),
        "--transparency=free",
        "--send-updates=none",
        `--private-prop=lifeMoment=${d.moment}`,
        `--private-prop=lifeHash=${d.hash}`,
      ]);
      const { id } = (JSON.parse(out) as { event: { id: string } }).event;
      log("calendar.write", { event: id, moment: d.moment, op: "create" });
    },
  };
}

/** Brings the calendar in line with the moments; null when it is not set up. */
export async function syncPast(now = clock()) {
  const calendar = process.env.LIFE_PAST_CALENDAR;
  const account = process.env.LIFE_PAST_ACCOUNT;
  if (!(calendar && account)) {
    return null;
  }
  const cal = pastCalendar(calendar, account);
  const want = await wanted(now);
  const { fresh, stale } = plan(
    want,
    await cal.held(nextDay(nextDay(now.toISOString().slice(0, 10))))
  );
  for (const e of stale) {
    // biome-ignore lint/performance/noAwaitInLoops: one call at a time, Google's rate limit
    await cal.remove(e.moment, e.id);
  }
  // The store is read before any network call, so it is never held open across them.
  const talks = await withStore((store) =>
    fresh.map((d) =>
      d.allDay ? [] : conversationsBetween(store, d.from, d.to)
    )
  );
  // A day's stays, asked once per sync.
  const days = new Map<string, Promise<Stay[]>>();
  const staysOn = (day: string) =>
    days.get(day) ?? (days.set(day, whereAt(day)).get(day) as Promise<Stay[]>);
  for (const [i, d] of fresh.entries()) {
    const { lines, location } = d.allDay
      ? { lines: [], location: d.place }
      : // biome-ignore lint/performance/noAwaitInLoops: one moment at a time
        await located(d, talks[i] ?? [], staysOn);
    const body = clip(redact([d.text, ...lines].join("\n")), DESCRIPTION_MAX);
    await cal.write(
      d,
      `${body}\n\nMoment ${d.moment}, written by Life.`,
      location
    );
  }
  return { events: want.length, removed: stale.length, written: fresh.length };
}
