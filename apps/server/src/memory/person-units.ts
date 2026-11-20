import type { SourceName } from "../core/names";
import type { Unit } from "../records/unit";
import type { Descriptor } from "../sources/contract";
import { readIndex, readUnitsOf } from "./memory-files";
import { OWNER } from "./read-truth";
import { isDirect, kindOf, SOURCES } from "./sources";

// A person's units, as the index files them: the one way a reader finds what someone said, wrote or was heard in (the
// network identity, a person's `latest`, `read_chats` with `who`). One query of the index, never a scan of a source.

/** A unit as the index lists it: what picks the units to read before any unit file is. */
export interface IndexedUnit {
  date: string;
  id: string;
  /** Who it is with, as the index files them today (`unitNow`): refs, or `unknown:<handle>` while no one is known by it. */
  people: string[];
  source: SourceName;
}

/**
 * The newest `count` units of `refs` (each a person ref, or `unknown:<handle>`) from sources of `kinds`, before the day
 * `before` (exclusive), newest first, and the rest of the oldest day's: a day is never cut, so the next page starts
 * `before` that day. Fewer when they have fewer. One query of the index.
 */
export const readPersonUnits = (
  refs: readonly string[],
  o: { before?: string; count: number; kinds: Descriptor["kind"][] }
): IndexedUnit[] =>
  readIndex((db) =>
    db
      .query<
        { date: string; id: string; people: string; source: SourceName },
        [string, string, string | null, number]
      >(
        `with mine as (
           select u.id, u.date, u.source from units u
            where u.id in (select unit from unit_people where person in (select value from json_each(?1)))
              and u.source in (select value from json_each(?2))
              and (?3 is null or u.date < ?3)),
         edge as (select date from mine order by date desc limit 1 offset ?4 - 1)
         select m.id, m.date, m.source,
                (select json_group_array(q.person) from unit_people q where q.unit = m.id) as people
           from mine m
          where m.date >= coalesce((select date from edge), '')
          order by m.date desc, m.id`
      )
      .all(
        JSON.stringify(refs),
        JSON.stringify(
          SOURCES.filter((s) => o.kinds.includes(s.kind)).map((s) => s.name)
        ),
        o.before ?? null,
        o.count
      )
      .map((r) => ({ ...r, people: JSON.parse(r.people) as string[] }))
  ) ?? [];

/** Whether a unit is with one of `refs` alone (besides him), as the index can tell: a group's day only its key tells. */
const isWithOnly = (
  u: Pick<IndexedUnit, "people">,
  refs: ReadonlySet<string>
) => {
  const others = u.people.filter((p) => p !== OWNER);
  return others.length === 1 && refs.has(others[0] as string);
};

/**
 * `readPersonUnits`' units read from their files (by the days the index gave), each with whether it is with `refs`
 * alone: the index's people say so and its key is no group's. The one test of "their 1:1 chat-day or thread" for
 * `latest`, reach and `read_chats` with `who`; a mail's senders no one knows the index leaves out, so `latest` checks
 * a thread's senders too.
 */
export function readPersonUnitFiles(
  refs: readonly string[],
  o: Parameters<typeof readPersonUnits>[1]
) {
  const listed = readPersonUnits(refs, o);
  const byId = new Map(listed.map((x) => [x.id, x]));
  const theirs = new Set(refs);
  const units = readUnitsOf([...new Set(listed.map((x) => x.date))]).flatMap(
    (unit): { direct: boolean; unit: Unit }[] => {
      const x = byId.get(unit.id);
      return x
        ? [
            {
              direct:
                isWithOnly(x, theirs) && isDirect(unit.source, unit.key, 1),
              unit,
            },
          ]
        : [];
    }
  );
  return { listed, units };
}

/** How many of a person's newest chat-days are read to find one that is 1:1 (the index can't tell a group). */
const TRIED = 3;

/**
 * The chat-days to try for a network identity, newest first: chat units whose one other person is one of `refs` (as the
 * index files them: their ref, or `unknown:<handle>` while no one is known by it), `TRIED` at most.
 */
export const chatUnitsFor = (
  units: readonly IndexedUnit[],
  refs: ReadonlySet<string>
) =>
  units
    .filter((u) => kindOf(u.source) === "chat" && isWithOnly(u, refs))
    .toSorted((a, b) => b.date.localeCompare(a.date))
    .slice(0, TRIED);
