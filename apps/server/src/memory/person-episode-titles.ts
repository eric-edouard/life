import type { Episode } from "../records/episode";

const EPISODE_TITLES_MAX = 60;

/** An episode's local time: its start, else its day. */
const whenOf = (m: Episode) => m.start ?? m.day;

/**
 * What his time with someone was about: the titles of the last 60 episodes they took part in (`with` him, or its
 * organizer; not one they were only told about), by month, newest first.
 */
export function episodeTitleLines(
  episodes: Episode[],
  isThem: (ref: string) => boolean
) {
  const kept = episodes
    .filter((m) => m.people.some((p) => p.role !== "told" && isThem(p.ref)))
    .toSorted((a, b) => whenOf(b).localeCompare(whenOf(a)))
    .slice(0, EPISODE_TITLES_MAX);
  return kept.length === 0
    ? []
    : [
        `## What their time together was about (titles of Life's last ${EPISODE_TITLES_MAX} episodes they took part in, newest first)`,
        ...[...Map.groupBy(kept, (m) => whenOf(m).slice(0, 7))].map(
          ([month, list]) =>
            `- ${month}: ${list.map((m) => m.title).join("; ")}`
        ),
        "",
      ];
}
