import type { Episode } from "../records/episode";

// The person read's first block, by code: what their time together was about.

const TALK_MAX = 60;

/** An episode's local time: its start, else its day. */
const whenOf = (m: Episode) => m.start ?? m.day;

/** The titles of the last 60 episodes where `isThem` names someone `with` him, by month, newest first. */
export function talkLines(
  episodes: Episode[],
  isThem: (ref: string) => boolean
) {
  const kept = episodes
    .filter((m) => m.people.some((p) => p.role === "with" && isThem(p.ref)))
    .toSorted((a, b) => whenOf(b).localeCompare(whenOf(a)))
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
