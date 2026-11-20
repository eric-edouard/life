import {
  daysOf,
  episodesNow,
  readCorrections,
  readEpisodeFiles,
  readIndex,
} from "./memory-files";

// A person's episodes, read through the index (`episode_people`, `index-writer.ts`): never every day of episodes.

/** Said when the index predates `episode_people`: it is rebuilt within the minute (`readStaleness`). */
const REBUILDING =
  "Life is rebuilding its index of who each episode is with: read again in a minute.";

/**
 * The episodes with `ref` as they stand, oldest first, a bounded read: the index names their episodes and the day
 * files holding a line of each (`episode_people`), only those files are read, and only those episodes' lines kept;
 * `refOf` reads each episode's people as of today. An index from before that table throws `REBUILDING`.
 */
export async function readEpisodesWith(
  ref: string,
  refOf: (ref: string) => string
) {
  let rows: { day: string; episode: string }[];
  try {
    rows =
      readIndex((db) =>
        db
          .query<{ day: string; episode: string }, [string]>(
            "select distinct episode, day from episode_people where episode in (select episode from episode_people where person = ?)"
          )
          .all(ref)
      ) ?? [];
  } catch (e) {
    throw new Error(REBUILDING, { cause: e });
  }
  const theirs = new Set(rows.map((r) => r.episode));
  const days = [...new Set(rows.map((r) => r.day))].toSorted();
  const lines = (await readEpisodeFiles(days))
    .map((x) => x.line)
    .filter((m) => theirs.has(m.id));
  return episodesNow(lines, readCorrections())
    .filter((m) => m.people.some((p) => refOf(p.ref) === ref))
    .toSorted((a, b) => daysOf(a)[0].localeCompare(daysOf(b)[0]));
}

/** Which of `ids` are standing episodes, as the index lists them (`searched_texts` holds every one): a bounded read. */
export const readStandingEpisodes = (ids: readonly string[]) =>
  readIndex((db) =>
    db
      .query<{ id: string }, [string]>(
        "select id from searched_texts where id in (select value from json_each(?))"
      )
      .all(JSON.stringify(ids))
      .map((r) => ({ id: r.id, people: [] }))
  ) ?? [];
