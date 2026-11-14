import type { Database } from "bun:sqlite";
import type { Episode } from "../records/episode";
import { SEARCHABLE_AT } from "../records/unit";
import { conversationsWith, type Store } from "../sources/lifelog";
import { episodeLine, latest, line } from "./index-rows";
import { daysOf } from "./memory-files";
import { type Mention, talkedAboutOf } from "./mentions";
import { tiesNow } from "./ties";
import { clip } from "./units";
import { type People, placementOf } from "./who";
import { localDate, localTime } from "./zones";

// A person's timeline (docs/glossary.md): everything dated Life holds about one person, newest first. The one place a
// person's dated evidence is gathered: the person read pages it and the history step writes their months from it.

/** One thing of a person's timeline: its day, which list it shows in, and its line. */
export interface Dated {
  day: string;
  kind: "conversation" | "episode" | "month" | "observation";
  line: string;
}

/** A thing of the timeline with what a reading of it needs: its weight, its last day and what happened (an episode's). */
export interface TimelineEntry extends Dated {
  importance: number;
  /** The last day it covers: an episode's end, else its day. */
  to: string;
  what?: string;
}

/** An episode of a person's timeline, and whether they were in it or only talked about. */
export interface TimelineEpisode {
  episode: Episode;
  isThere: boolean;
}

const NOT_THERE = " (they were talked about, not there)";

/** The kept mentions (`readMentions`) by the unit they were found in. */
export function mentionsByUnit(days: Record<string, Mention[]> | null) {
  return Map.groupBy(Object.values(days ?? {}).flat(), (m) => m.unit);
}

/**
 * The people each episode's units talked about, by episode id (`talkedAboutOf`, placed as `read-day.ts` places them):
 * worked out once for every episode, then asked of each person by `episodesOf`.
 */
export function talkedAbout(
  all: Episode[],
  people: People,
  mentions: Map<string, Mention[]>
) {
  const ties = tiesNow(people);
  const place = (m: Mention) => placementOf(m, people, ties)?.ref;
  return new Map(
    all.map((m) => [
      m.id,
      talkedAboutOf(
        m,
        m.units.flatMap((u) => mentions.get(u) ?? []),
        place,
        people.refOf
      ),
    ])
  );
}

/** The episodes of a person: those they take part in, and those whose units talked about them. The one rule of both callers. */
export const episodesOf = (
  all: Episode[],
  ref: string,
  refOf: (ref: string) => string,
  talked: Map<string, string[]>
): TimelineEpisode[] =>
  all.flatMap((episode): TimelineEpisode[] => {
    if (episode.people.some((p) => refOf(p.ref) === ref)) {
      return [{ episode, isThere: true }];
    }
    return talked.get(episode.id)?.includes(ref)
      ? [{ episode, isThere: false }]
      : [];
  });

/**
 * One timeline, newest first: the person's observations, episodes and recorded conversations. `asStood`: observations
 * since retired as history are kept (a reading of the past takes them as they were).
 */
export function timelineOf(
  db: Database,
  store: Store,
  ref: string,
  episodes: TimelineEpisode[],
  voiceIds: string[],
  asStood = false
): TimelineEntry[] {
  return [
    ...latest(
      db,
      "join observation_subjects l on l.observation = o.id where l.subject = ?",
      ref,
      -1,
      asStood
    ).map((r) => ({
      day: r.date,
      importance: r.importance,
      kind: "observation" as const,
      line: line(r),
      to: r.date,
    })),
    ...episodes.toReversed().map(({ episode: m, isThere }) => ({
      day: daysOf(m)[0],
      importance: m.importance,
      kind: "episode" as const,
      line: episodeLine(m) + (isThere ? "" : NOT_THERE),
      to: daysOf(m)[1],
      what: m.what || undefined,
    })),
    ...conversationsWith(store, voiceIds).map((c) => ({
      day: localDate(c.start_at),
      importance: SEARCHABLE_AT,
      kind: "conversation" as const,
      line: `- ${c.id} ${localTime(c.start_at)}: ${clip(c.title, 80)}`,
      to: localDate(c.start_at),
    })),
  ].toSorted((a, b) => b.day.localeCompare(a.day));
}
