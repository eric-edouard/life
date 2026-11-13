import { daysBefore } from "../core/clock";
import type { Episode } from "../records/episode";

// The person read's first two blocks, by code: their episodes of the last days, and what their time together was about.

const LATELY_DAYS = 14;
const LATELY_MAX = 12;
const TALK_MAX = 60;

/** An episode's local time: its start, else its day. */
const whenOf = (m: Episode) => m.start ?? m.day;

const newestFirst = (a: Episode, b: Episode) =>
  whenOf(b).localeCompare(whenOf(a));

/** The last 14 local days holding an episode with the person, newest first; 12 at most, the most important kept. */
export function latelyLines(episodes: Episode[], today: string) {
  const from = daysBefore(today, LATELY_DAYS - 1);
  const kept = episodes
    .filter((m) => whenOf(m).slice(0, 10) >= from)
    .toSorted((a, b) => b.importance - a.importance || newestFirst(a, b))
    .slice(0, LATELY_MAX)
    .toSorted(newestFirst);
  return kept.length === 0
    ? []
    : [
        `## Lately with them, day by day (Life's episodes of the last ${LATELY_DAYS} days, from every source; newest first)`,
        ...kept.map((m) => `- ${whenOf(m)} ${m.title}. ${m.what}`.trimEnd()),
        "",
      ];
}

/** The titles of the last 60 episodes where `isThem` names someone `with` him, by month, newest first. */
export function talkLines(
  episodes: Episode[],
  isThem: (ref: string) => boolean
) {
  const kept = episodes
    .filter((m) => m.people.some((p) => p.role === "with" && isThem(p.ref)))
    .toSorted(newestFirst)
    .slice(0, TALK_MAX);
  return kept.length === 0
    ? []
    : [
        `## What their time together was about (titles of Life's last ${TALK_MAX} episodes with them, newest first)`,
        ...[...Map.groupBy(kept, (m) => whenOf(m).slice(0, 7))].map(
          ([month, list]) =>
            `- ${month}: ${list.map((m) => m.title).join("; ")}`
        ),
        "",
      ];
}
