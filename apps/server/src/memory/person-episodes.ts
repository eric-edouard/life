import type { Episode } from "../records/episode";
import {
  daysOf,
  episodesNow,
  episodesWhere,
  readCorrections,
  readEpisodeFiles,
  readIndex,
} from "./memory-files";

// A person's episodes, read through the index (`episode_people`, `index-writer.ts`): never every day of episodes.

/**
 * The episodes with `ref` as they stand, oldest first, a bounded read: the index names the day files holding a line of
 * one of theirs (`episode_people`), and only those are read; `refOf` reads each episode's people as of today. An index
 * from before that table (rebuilt within the minute, `readStaleness`) reads every episode meanwhile.
 */
export async function readEpisodesWith(
  ref: string,
  refOf: (ref: string) => string
) {
  const isTheirs = (m: Episode) => m.people.some((p) => refOf(p.ref) === ref);
  let days: string[] | null;
  try {
    days = readIndex((db) =>
      db
        .query<{ day: string }, [string]>(
          "select distinct day from episode_people where episode in (select episode from episode_people where person = ?)"
        )
        .all(ref)
        .map((r) => r.day)
    );
  } catch {
    return episodesWhere(isTheirs);
  }
  const lines = (await readEpisodeFiles((days ?? []).toSorted())).map(
    (x) => x.line
  );
  return episodesNow(lines, readCorrections())
    .filter(isTheirs)
    .toSorted((a, b) => daysOf(a)[0].localeCompare(daysOf(b)[0]));
}
