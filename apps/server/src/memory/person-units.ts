import type { SourceName } from "../core/names";
import type { SourceEvent } from "../records/source";
import type { Unit } from "../records/unit";
import type { Descriptor } from "../sources/contract";
import { readIndex, readUnitsOf } from "./memory-files";
import { OWNER } from "./read-truth";
import { isDirect, kindOf, SOURCES, sourceOf } from "./sources";
import { holdsName, oneToOnePersonOf, type Resolve, UNKNOWN } from "./units";
import type { People } from "./who";

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

/** What a reader holds of a chat-day or thread: its chat, its name (none for a call-only day), its source. */
interface ChatHeld {
  chat: string;
  chatName?: string | null;
  source: SourceName;
}

/**
 * Who a chat-day only he wrote in is with: the one its key or name names (`oneToOnePersonOf`), else, while no one is
 * known by it, the handle its key holds as `unknown:<handle>`. None for a group's.
 */
export const onlyHisWithOf = (o: ChatHeld, resolve: Resolve) => {
  const handle = sourceOf(o.source).handleOf?.(o.chat);
  return (
    oneToOnePersonOf({ ...o, others: new Set() }, resolve) ??
    (handle ? `${UNKNOWN}${handle}` : null)
  );
};

/** What `isWithThemAlone` reads of one chat's events: its chat, its name (none for a call-only day) and who else wrote. */
export const chatHeldOf = (list: readonly SourceEvent[]) => {
  const [first] = list as [SourceEvent];
  return {
    chat: first.chat,
    chatName: list.every((e) => e.phoneCall) ? null : first.chatName,
    senders: list.filter((e) => !e.fromMe).map((e) => e.sender),
    source: first.source,
  };
};

/**
 * Whether a chat-day or thread is with `ref` alone, by its messages: its key is no group's and every other writer
 * reads as them; or its one other writer is one Life doesn't know whom the chat's own name places as them
 * (`oneToOnePersonOf`, never a mail's subject: a thread a stranger wrote in is not theirs, nor a room they and a stranger
 * wrote in); on a day only he wrote, it is theirs by
 * `onlyHisWithOf`. `latest` checks the index by it (which leaves out a mail's senders no one knows), today's
 * `read_chats` with `who` applies it before cutting to the range asked.
 */
export function isWithThemAlone(
  o: ChatHeld & { senders: readonly string[] },
  ref: string,
  { refOf, resolve }: Pick<People, "refOf" | "resolve">
) {
  if (o.senders.length === 0) {
    return onlyHisWithOf(o, resolve) === ref;
  }
  const others = new Set(
    o.senders.map((h) => refOf(`${UNKNOWN}${h}`, o.source))
  );
  if (!others.has(ref) || others.size > 1) {
    // Every distinct writer counted: the chat's name places one Life doesn't know only when they are its one other.
    const [other = ""] = others;
    return (
      others.size === 1 &&
      other.startsWith(UNKNOWN) &&
      oneToOnePersonOf({ ...o, others }, resolve) === ref
    );
  }
  return isDirect(o.source, o.chat, 1);
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

/** How many chats `readChatsTitled` names at most. */
const TITLED = 5;

/**
 * The newest `TITLED` chats (of `chat` alone when given) whose newest title holds `title` as a whole word run
 * (`holdsName`), each as its source and key: the fallback of `read_chats` with a `who` no unit of anyone holds. One
 * query of the index, a chat once however many days or names it has, two rooms of one title two chats.
 */
export function readChatsTitled(title: string, chat?: string) {
  const chatSources = SOURCES.filter((s) => s.kind === "chat").map(
    (s) => s.name
  );
  return (
    readIndex((db) =>
      db
        .query<{ chat: string; source: SourceName; title: string }, [string]>(
          "select source, chat, title, max(date) from units where source in (select value from json_each(?)) group by source, chat order by max(date) desc"
        )
        .all(JSON.stringify(chatSources))
        .filter(
          (u) => holdsName(u.title, [title]) && (!chat || u.chat === chat)
        )
        .slice(0, TITLED)
        .map((u) => ({ key: u.chat, source: u.source }))
    ) ?? []
  );
}
