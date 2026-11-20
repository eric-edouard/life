import { clock, DAY, daysBefore } from "../core/clock";
import { isNextPageKnown } from "../core/lists";
import { chatGroups, type SourceEvent } from "../records/source";
import {
  chatHeldOf,
  isWithThemAlone,
  readChatsTitled,
  readPersonUnitFiles,
} from "./person-units";
import type { Tables } from "./sources";
import { isLifeOutput, UNKNOWN } from "./units";
import type { People } from "./who";
import { type DayRange, dayStart, localDate } from "./zones";

// Reading chat messages from their sources for `read_chats` (`chatsOf`, words.ts): a range of days, or one person's.

/** How many messages a page of `read_chats` holds. */
export const PAGE = 200;

/** The messages from `start` to `end` (exclusive), Life's own output left out, oldest first. */
export const between = (events: SourceEvent[], start: Date, end: Date) =>
  events
    .filter(
      (e) =>
        e.at >= start.toISOString() &&
        e.at < end.toISOString() &&
        !isLifeOutput(e)
    )
    .sort((a, b) => a.at.localeCompare(b.at));

/** Source-backed chat reads: the explicit end is exclusive, including backward pagination. */
export function readChats(
  range: DayRange,
  sources: Partial<Tables["CHATS"]>,
  days?: number
) {
  const end = range.to ? new Date(range.to) : clock();
  const start = range.from
    ? new Date(range.from)
    : new Date(
        days === undefined ? 0 : Math.max(0, end.getTime() - days * DAY)
      );
  const failed: string[] = [];
  const events = Object.entries(sources).flatMap(([name, read]) => {
    try {
      return read?.(start, end) ?? [];
    } catch {
      failed.push(name);
      return [];
    }
  });
  return { end, events: between(events, start, end), failed, start };
}

/**
 * What `chatsOf` reads: `who`'s units (all history), or the days of `chat` and the like; a `who` no one is known by whose
 * units hold nothing falls back to the chats its words title, read as `chat` reads them (7 days without `from`). `chat`
 * and the titles both narrow, never one for the other.
 */
export function readWhoChats(
  o: { chat?: string; who?: string },
  known: string | undefined,
  ref: string,
  range: DayRange,
  before: string | undefined,
  sources: Partial<Tables["CHATS"]>,
  people: People
) {
  const days = () => readChats(range, sources, before ? undefined : 7);
  const keep = (
    r: ReturnType<typeof days>,
    ok: (e: SourceEvent) => boolean
  ) => ({
    ...r,
    events: r.events.filter(ok),
  });
  const isChosen = (e: SourceEvent) => !o.chat || e.chat === o.chat;
  const first = keep(
    o.who ? personChats(ref, range, sources, people, o.chat) : days(),
    isChosen
  );
  const titled =
    o.who && !known && first.events.length === 0 ? readChatsTitled(o.who) : [];
  if (titled.length === 0) {
    return { ...first, person: !!o.who };
  }
  const isTitled = (e: SourceEvent) =>
    titled.some((t) => t.source === e.source && t.key === e.chat);
  return {
    ...keep(days(), (e) => isChosen(e) && isTitled(e)),
    person: false,
  };
}

/** How many of a person's chat units one round reads from the index: whole days, until a page is full. */
const ROUND = 40;

/**
 * A person's chat messages in `range` (of `chat` alone when given), oldest first: their one-to-one chat-days whole,
 * their own words in a group's. The range's last day is read whole once (what the index has not listed yet is in it);
 * earlier days through their units (`readPersonUnitFiles`), each span read once, until the next page is known.
 */
function personChats(
  ref: string,
  range: DayRange,
  sources: Partial<Tables["CHATS"]>,
  people: People,
  chat?: string
) {
  const { refOf } = people;
  const end = range.to ? new Date(range.to) : clock();
  const start = new Date(range.from ?? 0);
  const isTheirs = (e: SourceEvent) =>
    !e.fromMe && refOf(`${UNKNOWN}${e.sender}`, e.source) === ref;
  const wanted = (list: SourceEvent[]) =>
    between(list, start, end).filter((e) => !chat || e.chat === chat);
  const today = localDate(end.toISOString());
  // The end's day is read whole, so who a chat is with is known before it is cut to the range asked.
  const [from, to] = [today, daysBefore(today, -1)].map((d) => dayStart(d));
  const fresh =
    end > (from as Date)
      ? readChats({ from: from?.toISOString(), to: to?.toISOString() }, sources)
      : undefined;
  const failed = new Set(fresh?.failed);
  // That day's chats: one with them alone whole (`isWithThemAlone`), another their own words.
  const events = [...chatGroups(fresh?.events ?? []).values()].flatMap((list) =>
    wanted(
      isWithThemAlone(chatHeldOf(list), ref, people)
        ? list
        : list.filter(isTheirs)
    )
  );
  let day: string | undefined = fresh ? today : daysBefore(today, -1);
  const isKnown = () =>
    isNextPageKnown(
      events.map((e) => e.at),
      PAGE
    );
  while (day && !isKnown() && day > localDate(start.toISOString())) {
    const { listed, units } = readPersonUnitFiles([ref], {
      before: day,
      count: ROUND,
      kinds: ["chat"],
    });
    for (const { direct, unit: u } of units) {
      const read = sources[u.source];
      try {
        events.push(
          ...wanted(
            (read?.(new Date(u.start), new Date(Date.parse(u.end) + 1)) ?? [])
              .filter((e) => e.chat === u.key && e.at <= u.end)
              .filter((e) => direct || isTheirs(e))
          )
        );
      } catch {
        failed.add(u.source);
      }
    }
    day = listed.at(-1)?.date;
  }
  return {
    end,
    events: events.toSorted((a, b) => a.at.localeCompare(b.at)),
    failed: [...failed],
    start,
  };
}
