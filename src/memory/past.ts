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
import {
  digest,
  momentsNow,
  readCorrections,
  readMoments,
  readUnits,
} from "./ledger";
import { clip, daysBefore, time } from "./units";
import { observationsNow, readPeople } from "./who";
import { dayStart, localDate } from "./zones";

// The Past calendar (his request, 21 Oct): every moment that happened, as an event in his Google calendar
// `LIFE_PAST_CALENDAR` (of the account `LIFE_PAST_ACCOUNT`, through `gog`), with who, where he was (lifelog's stays),
// the conversations recorded, what Life noted and every unit it was read from. A one-way projection of the moments,
// like the board: each event carries its moment's id and a hash of what it shows (private properties), a moment that
// changed is written again, one gone (hidden, cancelled, never happened) is deleted. Nothing is read back. Each
// nightly tick runs it after its turn, so a moment is on the calendar within 30 minutes of being read.

const HOUR = 3_600_000;
const REF_KIND = /^(person|unknown):/;
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
  names: Map<string, string>;
  /** What Life noted, by unit: the observations that show. */
  noted: Map<string, string[]>;
  refOf: (ref: string) => string;
  units: Map<string, Unit>;
}

const nextDay = (day: string) => daysBefore(day, -1);
const instant = (local: string) => {
  const [day = "", hm] = local.split(" ");
  return dayStart(day, undefined, hm).toISOString();
};

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

/** The events the calendar should hold: every moment that happened and had started by `now`, oldest first. */
export function drafts(moments: Moment[], k: Known, now: Date): Draft[] {
  return moments
    .filter((m) => m.status === "happened")
    .map((m) => ({ m, ...span(m) }))
    .filter(
      ({ allDay, from }) =>
        (allDay ? dayStart(from) : new Date(from)).getTime() <= now.getTime()
    )
    .toSorted((a, b) => a.from.localeCompare(b.from))
    .map(({ m, ...when }) => {
      const name = (ref: string) => {
        const r = k.refOf(ref);
        return k.names.get(r) ?? r.replace(REF_KIND, "");
      };
      const units = m.units.flatMap((id) => k.units.get(id) ?? []);
      const noted = m.units.flatMap((id) => k.noted.get(id) ?? []);
      const text = [
        m.why,
        "",
        m.people.length > 0
          ? `With: ${m.people.map((p) => (p.role === "with" ? name(p.ref) : `${name(p.ref)} (${p.role})`)).join(", ")}`
          : "Alone, or no one named",
        ...(m.place ? [`Place: ${m.place}`] : []),
        `Importance: ${["ordinary", "worth remembering in a month", "a landmark"][m.importance - 1]}`,
        ...(noted.length > 0
          ? [
              "",
              "What Life noted:",
              ...[...new Set(noted)].map((t) => `- ${t}`),
            ]
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

const maps = (s: Stay) =>
  `https://maps.google.com/?q=${s.latitude.toFixed(5)},${s.longitude.toFixed(5)}`;

/** The stays and conversations of a timed event, read now (lifelog's stays of its days, Life's store), as description lines. */
async function located(d: Draft, staysOn: (day: string) => Promise<Stay[]>) {
  if (d.allDay) {
    return { lines: [], location: d.place };
  }
  const days = [...new Set([localDate(d.from), localDate(d.to)])];
  const stays = (await Promise.all(days.map(staysOn)))
    .flat()
    .filter((s) => s.arrivedAt < d.to && (s.leftAt ?? d.to) > d.from)
    .toSorted((a, b) => a.arrivedAt.localeCompare(b.arrivedAt));
  const talks = await withStore((store) =>
    conversationsBetween(store, d.from, d.to)
  );
  const [longest] = stays.toSorted(
    (a, b) =>
      Date.parse(a.arrivedAt) -
      Date.parse(a.leftAt ?? d.to) -
      (Date.parse(b.arrivedAt) - Date.parse(b.leftAt ?? d.to))
  );
  return {
    lines: [
      ...(stays.length > 0
        ? [
            "",
            "Where he was (lifelog):",
            ...stays.map(
              (s) =>
                `- ${time(s.arrivedAt)}–${s.leftAt ? time(s.leftAt) : "…"} ${s.place ?? "unnamed place"} ${maps(s)}`
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
    location:
      d.place ??
      (longest
        ? (longest.place ??
          `${longest.latitude.toFixed(5)},${longest.longitude.toFixed(5)}`)
        : null),
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
    momentsNow(moments, readCorrections()),
    {
      names: people.names,
      noted: new Map(
        [...Map.groupBy(observations, (o) => o.unit)].map(([u, os]) => [
          u,
          os.map((o) => o.text),
        ])
      ),
      refOf: people.refOf,
      units: new Map(units.map((u) => [u.id, u])),
    },
    now
  );
}

/** The Past calendar through `gog`: what it holds of Life's (events with a moment id, by moment), and its writes. */
function pastCalendar(calendar: string, account: string) {
  const run = async (args: string[]) => {
    const r = await exec([
      "gog",
      "calendar",
      ...args,
      "--account",
      account,
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
      const held = new Map<string, { hash?: string; id: string }[]>();
      let page = "";
      do {
        const r = PastEvents(
          // biome-ignore lint/performance/noAwaitInLoops: pages follow one another
          await run([
            "events",
            calendar,
            "--from",
            "2000-01-01",
            "--to",
            until,
            "--max",
            "2500",
            ...(page ? ["--page", page] : []),
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
        "--summary",
        redact(d.summary),
        "--from",
        d.from,
        "--to",
        d.to,
        ...(d.allDay ? ["--all-day"] : []),
        "--description",
        description,
        ...(location ? ["--location", redact(location)] : []),
        "--transparency",
        "free",
        "--send-updates",
        "none",
        "--private-prop",
        `lifeMoment=${d.moment}`,
        "--private-prop",
        `lifeHash=${d.hash}`,
      ]);
      const { id } = (JSON.parse(out) as { event: { id: string } }).event;
      log("calendar.write", { event: id, moment: d.moment, op: "create" });
    },
  };
}

/** Brings the calendar in line with the moments; null when it is not set up. */
export async function syncPast(now = new Date()) {
  const calendar = process.env.LIFE_PAST_CALENDAR;
  const account = process.env.LIFE_PAST_ACCOUNT;
  if (!(calendar && account)) {
    return null;
  }
  const cal = pastCalendar(calendar, account);
  const want = await wanted(now);
  const held = await cal.held(nextDay(nextDay(now.toISOString().slice(0, 10))));
  // A moment shown as it is now, once, stays as it is.
  const keep = new Set(
    want.flatMap((d) => {
      const [e, ...more] = held.get(d.moment) ?? [];
      return e?.hash === d.hash && more.length === 0 ? [d.moment] : [];
    })
  );
  // Every event of a moment gone or changed goes; a changed one is written again below.
  const stale = [...held].flatMap(([moment, events]) =>
    keep.has(moment) ? [] : events.map((e) => ({ id: e.id, moment }))
  );
  for (const e of stale) {
    // biome-ignore lint/performance/noAwaitInLoops: one call at a time, Google's rate limit
    await cal.remove(e.moment, e.id);
  }
  // A day's stays, asked once per sync.
  const days = new Map<string, Promise<Stay[]>>();
  const staysOn = (day: string) =>
    days.get(day) ?? (days.set(day, whereAt(day)).get(day) as Promise<Stay[]>);
  const fresh = want.filter((d) => !keep.has(d.moment));
  for (const d of fresh) {
    // biome-ignore lint/performance/noAwaitInLoops: one moment at a time
    const { lines, location } = await located(d, staysOn);
    await cal.write(
      d,
      clip(
        redact(
          [d.text, ...lines, "", `Moment ${d.moment}, written by Life.`].join(
            "\n"
          )
        ),
        DESCRIPTION_MAX
      ),
      location
    );
  }
  return { events: want.length, removed: stale.length, written: fresh.length };
}
