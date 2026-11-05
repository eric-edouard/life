import { HOUR } from "../core/clock";
import { digest } from "../core/hash";
import { redact } from "../core/redact";
import type { Episode } from "../records/episode";
import type { Unit } from "../records/unit";
import { conversationsBetween, visits, withStore } from "../sources/lifelog";
import { endOf, span } from "./episode-span";
import { episodesNow, readBy, readEpisodes, readUnitsOf } from "./ledger";
import { stayOf, where } from "./places";
import { readIndex } from "./search";
import { episodeText } from "./statements";
import { clip, time } from "./units";
import { readPeople } from "./who";

// The Past calendar (his request, 21 Oct): what it should hold. Every episode, as an event with what happened, who,
// where he was (lifelog's stays), the conversations recorded, what Life noted and every unit it was read from. A
// one-way projection of the episodes: each event carries its episode's id and a hash of what it shows,
// an episode that changed is written again, one gone (hidden, or read again as something else) is deleted.
// `host/past-calendar.ts` writes it.

// ponytail: an episode goes on the calendar 2 h after it ends, so lifelog has its stays: they are read once, when it
// is written, and are not in its hash. Hash them (a read per episode each tick) if late stays turn out to matter.
const SETTLE = 2 * HOUR;
// Google takes 8,192 characters; a busy episode's units would pass it.
const DESCRIPTION_MAX = 7500;

/** One episode as an event, before the IO-bound part (stays and conversations, added only when it is written). */
export interface Draft {
  allDay: boolean;
  episode: string;
  /** RFC3339 instants, or YYYY-MM-DD days (end exclusive) when `allDay`. */
  from: string;
  hash: string;
  place: string | null;
  summary: string;
  text: string;
  to: string;
}

interface Known {
  /** Each unit's episode, of every episode (`readBy`): a fact shows under it only. */
  byEpisode: ReadonlyMap<string, Episode>;
  nameOf: (ref: string) => string;
  /** What Life noted, by unit: the observations that show. */
  noted: Map<string, string[]>;
  units: Map<string, Unit>;
}

/**
 * The events the calendar should hold of `episodes`: those ended (`SETTLE` ago) by `now`. They may overlap (his
 * decision, 2 Nov): a big episode holds the smaller ones that happened inside it.
 */
export function drafts(episodes: Episode[], k: Known, now: Date): Draft[] {
  return episodes
    .filter((m) => endOf(m) + SETTLE <= now.getTime())
    .map((m) => ({ m, ...span(m) }))
    .map(({ m, ...when }) => {
      const units = m.units.flatMap((id) => k.units.get(id) ?? []);
      const noted = [
        ...new Set(
          m.units.flatMap((id) =>
            k.byEpisode.get(id) === m ? (k.noted.get(id) ?? []) : []
          )
        ),
      ];
      const text = [
        m.what,
        "",
        episodeText(m, k.nameOf),
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
        episode: m.id,
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

/**
 * What a sync does: the events to delete (of an episode gone or changed, and any second copy) and the drafts to write.
 * A held event of a `live` episode not drafted (outside the sync's window, or not ended `SETTLE` ago) stays.
 */
export function plan(want: Draft[], held: Held, live: ReadonlySet<string>) {
  const drafted = new Set(want.map((d) => d.episode));
  const keep = new Set(
    want.flatMap((d) => {
      const [e, ...more] = held.get(d.episode) ?? [];
      return e?.hash === d.hash && more.length === 0 ? [d.episode] : [];
    })
  );
  return {
    fresh: want.filter((d) => !keep.has(d.episode)),
    stale: [...held].flatMap(([episode, events]) =>
      keep.has(episode) || (live.has(episode) && !drafted.has(episode))
        ? []
        : events.map((e) => ({ episode, id: e.id }))
    ),
  };
}

/** A timed event's stays (read when it is written) and conversations, as description lines and a location: the stay where he was most of it, else the episode's place. */
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

/**
 * The drafts of the episodes ending after `since` (all without it) as memory holds them now, and every episode's id;
 * null before the index exists (what Life noted is read there, in its order: that of `observationsNow`).
 */
export async function wanted(now: Date, since?: Date) {
  const [people, lines] = await Promise.all([readPeople(), readEpisodes()]);
  const episodes = episodesNow(lines, people.corrections);
  const after = since?.getTime() ?? 0;
  const shown = episodes.filter((m) => endOf(m) > after);
  const ids = new Set(shown.map((m) => m.id));
  // An episode line's units are of its day (episodes.ts reads a day's units).
  const units = readUnitsOf([
    ...new Set(lines.filter((l) => ids.has(l.id)).map((l) => l.day)),
  ]);
  const noted = readIndex((db) =>
    db
      .query<{ text: string; unit: string }, [string]>(
        "select unit, text from observations where unit in (select value from json_each(?)) order by rowid"
      )
      .all(JSON.stringify(units.map((u) => u.id)))
  );
  if (!noted) {
    return null;
  }
  const k: Known = {
    byEpisode: readBy(episodes),
    nameOf: people.nameOf,
    noted: new Map(
      [...Map.groupBy(noted, (o) => o.unit)].map(([u, os]) => [
        u,
        os.map((o) => o.text),
      ])
    ),
    units: new Map(units.map((u) => [u.id, u])),
  };
  return {
    drafts: drafts(shown, k, now),
    live: new Set(episodes.map((m) => m.id)),
  };
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
      : // biome-ignore lint/performance/noAwaitInLoops: one episode at a time
        await located(d, talks[i] ?? []);
    const body = clip(redact([d.text, ...lines].join("\n")), DESCRIPTION_MAX);
    yield {
      d,
      description: `${body}\n\nEpisode ${d.episode}, written by Life.`,
      location,
    };
  }
}
