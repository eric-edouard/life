import { HOUR } from "../core/clock";
import { digest } from "../core/hash";
import { redact } from "../core/redact";
import type { Moment } from "../records/moment";
import type { Unit } from "../records/unit";
import { conversationsBetween, visits, withStore } from "../sources/lifelog";
import { momentsNow, readBy, readMoments, readUnits } from "./ledger";
import { stayOf, where } from "./places";
import { momentText } from "./statements";
import { clip, daysBefore, time } from "./units";
import { observationsNow, readPeople } from "./who";
import { dayStart } from "./zones";

// The Past calendar (his request, 21 Oct): what it should hold. Every moment, as an event with what happened, who,
// where he was (lifelog's stays), the conversations recorded, what Life noted and every unit it was read from. A
// one-way projection of the moments: each event carries its moment's id and a hash of what it shows,
// a moment that changed is written again, one gone (hidden, or read again as something else) is deleted.
// `host/past-calendar.ts` writes it.

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
  /** What Life noted, by unit: the observations that show (under the unit's moment, `readBy`). */
  noted: Map<string, string[]>;
  units: Map<string, Unit>;
}

const nextDay = (day: string) => daysBefore(day, -1);
const instant = (local: string) => {
  const [day = "", hm] = local.split(" ");
  return dayStart(day, undefined, hm).toISOString();
};
/** An event's edge as an instant: a day's start in his zone then, or the instant itself. */
export const edgeTime = (allDay: boolean, edge: string) =>
  (allDay ? dayStart(edge) : new Date(edge)).getTime();

/** When a moment was: its timed start to its end (an hour when the sources don't say), else whole days. */
export function span(m: Pick<Moment, "day" | "end" | "start">) {
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
  // ponytail: an hour when no end is known.
  const to = end > from ? end : new Date(Date.parse(from) + HOUR).toISOString();
  return { allDay: false, from, to };
}

/**
 * The events the calendar should hold: every moment ended (`SETTLE` ago) by `now`. They may overlap (his decision,
 * 2 Nov): a big moment holds the smaller ones that happened inside it.
 */
export function drafts(moments: Moment[], k: Known, now: Date): Draft[] {
  const byMoment = readBy(moments);
  return moments
    .map((m) => ({ m, ...span(m) }))
    .filter(({ allDay, to }) => edgeTime(allDay, to) + SETTLE <= now.getTime())
    .map(({ m, ...when }) => {
      const units = m.units.flatMap((id) => k.units.get(id) ?? []);
      const noted = [
        ...new Set(
          m.units.flatMap((id) =>
            byMoment.get(id) === m ? (k.noted.get(id) ?? []) : []
          )
        ),
      ];
      const text = [
        m.what,
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
        summary:
          m.place && !m.title.toLowerCase().includes(m.place.toLowerCase())
            ? `${m.title} · ${m.place}`
            : m.title,
        text,
      };
      return { ...draft, hash: digest("sha1", JSON.stringify(draft), 12) };
    });
}

export type Held = Map<string, { hash?: string; id: string }[]>;

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

/** A timed event's stays (read when it is written) and conversations, as description lines and a location: the stay where he was most of it, else the moment's place. */
async function located(
  d: Draft,
  talks: { id: string; start_at: string; title: string }[]
) {
  const stays = (await visits({ from: d.from, to: d.to }))
    .filter((s) => s.arrivedAt < d.to && (s.leftAt ?? d.to) > d.from)
    .toSorted((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));
  const longest = stayOf(d.from, d.to, stays);
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
    location: longest ? where(longest) : d.place,
  };
}

/** The drafts of every moment as memory holds it now. */
export async function wanted(now: Date) {
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

/** Each draft with the description and location it is written with, one at a time (stays are read as it comes). */
export async function* described(fresh: Draft[]) {
  // The store is read before any network call, so it is never held open across them.
  const talks = await withStore((store) =>
    fresh.map((d) =>
      d.allDay ? [] : conversationsBetween(store, d.from, d.to)
    )
  );
  for (const [i, d] of fresh.entries()) {
    const { lines, location } = d.allDay
      ? { lines: [], location: d.place }
      : // biome-ignore lint/performance/noAwaitInLoops: one moment at a time
        await located(d, talks[i] ?? []);
    const body = clip(redact([d.text, ...lines].join("\n")), DESCRIPTION_MAX);
    yield {
      d,
      description: `${body}\n\nMoment ${d.moment}, written by Life.`,
      location,
    };
  }
}
