import { z } from "zod";
import { DAY, daysBefore, HOUR, MIN } from "../core/clock";
import { readJson, removeAllBut } from "../core/files";
import { digest } from "../core/hash";
import { callCharsOf, stamp } from "../models/llm";
import {
  GIST_MAX,
  Persona,
  PersonaLine,
  type PersonaQuote,
} from "../records/persona";
import type { SourceEvent } from "../records/source";
import type { Unit } from "../records/unit";
import { openStore } from "../sources/lifelog";
import { directChats, pagedNow, type WithPeople } from "./closeness";
import { PERSONAS, pagePath, personaPath, readUnits } from "./ledger";
import { locate } from "./observe";
import { OWNER } from "./read-truth";
import { begin, inBatches, meContext } from "./run";
import { isDirect, kindOf, safely, tables } from "./sources";
import {
  clip,
  dayUnitId,
  isFrozen,
  isLifeOutput,
  speakerOf,
  textOf,
} from "./units";
import { type People, readPeople, unitNow } from "./who";
import { messageLine, spokenLines } from "./words";
import { localDate, time } from "./zones";

// `bun life memory personas`: what each person with a page is like, wants and can give, what keeps happening between them
// and the owner,
// and how each writes to the other (docs/architecture.md, "The pipeline"); his own across everyone and his own writing
// (his notes, his imported assistant chats). One call per person reads what passed between them over 3 years: their 1:1
// messages and the group chat-days they wrote in (the night's `readWithPeople`), and his recorded conversations where
// they spoke (the stored units, words read only when due), whole when it fits one call (`callCharsOf`), else sampled
// across the years (`sampleOf`), with their page and code's counts over the 1:1 messages (`pairCountsOf`), and
// writes the persona whole, at most once a week and only when something new was said. Every quote is checked against
// what was shown. Nothing is sent.

const PERSONA_PROMPT = "memory-persona.v2";
/** Characters of their page shown (Life's own text). */
const PAGE_MAX = 20_000;
/** How old a persona gets before new messages rebuild it: people change slowly; the situation reads it each night against the newest days (his choice, 8 Nov). */
const REBUILD_AFTER = 7 * DAY;
/** A line seen on fewer days is `thin`; one whose newest quote is older than a year is `old`. */
const SOLID_DAYS = 3;
const OLD_AFTER_DAYS = 365;

/** A quiet this long before a message makes its writer the one who opened the exchange. */
const OPENS_AFTER = 6 * HOUR;

/** What code counts between him and one person over their 1:1 messages (`directChats`), for their persona. */
export interface PairCounts {
  /** Local days with a message. */
  days: number;
  /** Messages each way, and how many of them their writer deleted. */
  got: number;
  gotDeleted: number;
  /** Median minutes from the other's message to an answer (under OPENS_AFTER), each way; null when none. */
  heAnswersIn: number | null;
  /** Who wrote first after OPENS_AFTER of quiet. */
  heOpened: number;
  sent: number;
  sentDeleted: number;
  theyAnswerIn: number | null;
  theyOpened: number;
}

const median = (xs: number[]) =>
  xs.length > 0
    ? Math.round(xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0)
    : null;

export function pairCountsOf(list: SourceEvent[]): PairCounts {
  const c = {
    got: 0,
    gotDeleted: 0,
    heOpened: 0,
    sent: 0,
    sentDeleted: 0,
    theyOpened: 0,
  };
  const waits = { him: [] as number[], them: [] as number[] };
  const sorted = list.toSorted((a, b) => a.at.localeCompare(b.at));
  let last: SourceEvent | undefined;
  for (const e of sorted) {
    const deleted = e.deleted ? 1 : 0;
    const gap = last
      ? Date.parse(e.at) - Date.parse(last.at)
      : Number.POSITIVE_INFINITY;
    if (e.fromMe) {
      c.sent += 1;
      c.sentDeleted += deleted;
      c.heOpened += gap >= OPENS_AFTER ? 1 : 0;
    } else {
      c.got += 1;
      c.gotDeleted += deleted;
      c.theyOpened += gap >= OPENS_AFTER ? 1 : 0;
    }
    if (last && gap < OPENS_AFTER && last.fromMe !== e.fromMe) {
      (e.fromMe ? waits.him : waits.them).push(gap / MIN);
    }
    last = e;
  }
  return {
    ...c,
    days: new Set(sorted.map((e) => localDate(e.at))).size,
    heAnswersIn: median(waits.him),
    theyAnswerIn: median(waits.them),
  };
}

/** Someone's persona; none when there is none or it was written in an older shape (then it is due). */
export const readPersona = (ref: string) => {
  const p = Persona.safeParse(readJson(personaPath(ref)));
  return p.success ? p.data : null;
};

/** How well a line is backed, from its quotes' days: a pattern seen once is a guess, one not seen for a year may be over. */
export function supportOf(quotes: PersonaQuote[], today: string) {
  const days = [...new Set(quotes.map((q) => localDate(q.at)))].sort();
  const newest = days.at(-1);
  if (newest && newest < daysBefore(today, OLD_AFTER_DAYS)) {
    return "old" as const;
  }
  return days.length >= SOLID_DAYS ? ("solid" as const) : ("thin" as const);
}

const quoted = (quotes: PersonaQuote[]) =>
  quotes.length > 0
    ? ` E.g. ${quotes.map((q) => `"${q.text}" (${localDate(q.at)})`).join(", ")}`
    : "";

/** A persona's readings of the person and what is between them, without the writing lines (those are for drafting). */
export const readingsOf = (lines: PersonaLine[]) =>
  lines.flatMap((l) => (l.facet === "writes" ? [] : [l]));

/**
 * A persona as a reader shows it: its gist, then the readings under Persona, each with its support; the writing lines
 * under Communication style (the connector's word for them). Nothing when there is none.
 */
export function personaBlock(
  persona: Pick<Persona, "gist" | "lines"> | null,
  today: string
) {
  const lines = persona?.lines ?? [];
  const readings = readingsOf(lines);
  const writes = lines.flatMap((l) => (l.facet === "writes" ? [l] : []));
  return [
    ...(readings.length > 0
      ? [
          `Persona (what they are like, want and can give, and what keeps happening between them and him, read every ${REBUILD_AFTER / DAY} days from 3 years of their messages, group chats and his recordings with them; solid: seen on ${SOLID_DAYS} days or more, thin: fewer, old: not seen for a year):`,
          `- in short: ${persona?.gist}`,
          ...readings.map(
            (l) =>
              `- ${l.facet} (${supportOf(l.quotes, today)}): ${l.text}${quoted(l.quotes)}`
          ),
          "",
        ]
      : []),
    ...(writes.length > 0
      ? [
          `Communication style (how he writes to them and they to him, read every ${REBUILD_AFTER / DAY} days; follow his when drafting for him):`,
          ...writes.map(
            (l) =>
              `- ${l.writer === "owner" ? "he writes" : "they write"}${l.kind ? `, ${l.kind}` : ""}${l.source ? ` (${l.source})` : ""}: ${l.text}${quoted(l.quotes)}`
          ),
          "",
        ]
      : []),
  ];
}

/** One message or recorded turn as the persona call is shown it: who said it ("him" or their name). */
interface Shown {
  at: string;
  deleted: boolean;
  fromMe: boolean;
  text: string;
  who: string;
}

/** Where a day was between them: their 1:1 chat or mail thread, a group chat both are in, his recordings, or (his own persona) what he wrote for himself. */
type DayKind = "direct" | "group" | "own_writing" | "spoken";

/** What a sample weighs a day by: its characters, and how much happened in it. */
interface Sampled {
  day: string;
  eventful: number;
  size: number;
}

/** One day of one chat, mail thread or recorded conversation shown: with whom, its messages. */
interface ShownDay extends Sampled {
  kind: DayKind;
  messages: Shown[];
  source: Unit["source"];
  with: string;
}

const sizeOf = (messages: Shown[]) =>
  messages.reduce((n, m) => n + m.text.length + 20, 0);

/** Events as days, one per chat-day (`dayUnitId`), oldest first; a day says more with each message and each one deleted. */
export function shownDaysOf(
  events: SourceEvent[],
  kind: DayKind,
  whoOf: (e: SourceEvent) => string,
  withOf: (e: SourceEvent) => string
) {
  return [
    ...Map.groupBy(
      events.toSorted((a, b) => a.at.localeCompare(b.at)),
      dayUnitId
    ).values(),
  ].map((list): ShownDay => {
    const first = list[0] as SourceEvent;
    const messages = list.map((e) => ({
      at: e.at,
      deleted: !!e.deleted,
      fromMe: e.fromMe,
      text: textOf(e),
      who: whoOf(e),
    }));
    return {
      day: localDate(first.at),
      eventful: messages.length + 5 * messages.filter((m) => m.deleted).length,
      kind,
      messages,
      size: sizeOf(messages),
      source: first.source,
      with: withOf(first),
    };
  });
}

/**
 * The days a persona reads, oldest first, to `budget` characters: the newest fifth, then the rest shared evenly by year,
 * each month's most eventful day in turn, so what keeps repeating shows across the years.
 */
export function sampleOf<T extends Sampled>(all: T[], budget: number) {
  const days = all.toSorted((a, b) => b.day.localeCompare(a.day));
  const taken = new Set<T>();
  let used = 0;
  const take = (list: T[], upTo: number) => {
    for (const d of list) {
      if (!taken.has(d) && used + d.size <= upTo) {
        taken.add(d);
        used += d.size;
      }
    }
  };
  take(days, budget / 5);
  // The rest shared evenly by year, the years with least first so what a small year leaves goes to the others.
  const years = [
    ...Map.groupBy(
      days.filter((d) => !taken.has(d)),
      (d) => d.day.slice(0, 4)
    ).values(),
  ].toSorted(
    (a, b) =>
      a.reduce((n, d) => n + d.size, 0) - b.reduce((n, d) => n + d.size, 0)
  );
  for (const [i, year] of years.entries()) {
    // Each month's most eventful day in turn, then each month's next: eventful days, spread across the year.
    const months = [
      ...Map.groupBy(year, (d) => d.day.slice(0, 7)).values(),
    ].map((m) => m.toSorted((a, b) => b.eventful - a.eventful));
    const turns = Math.max(...months.map((m) => m.length));
    take(
      Array.from({ length: turns }, (_, k) =>
        months.flatMap((m) => m[k] ?? [])
      ).flat(),
      used + (budget - used) / (years.length - i)
    );
  }
  return days.filter((d) => taken.has(d)).toReversed();
}

/** The day as the prompt reads it: each message `HH:MM <who>: text[ (deleted)]`. */
const linesOf = (d: ShownDay) =>
  d.messages.map((m) => messageLine(time(m.at), m.who, m.text, m.deleted));

/** A day as the prompt reads it. */
const dayInput = (d: ShownDay) => ({
  day: d.day,
  kind: d.kind,
  lines: linesOf(d),
  source: d.source,
  with: d.with,
});

/** A recorded conversation-day before its sample has read its words; a chapter (`isFrozen`) lifelog holds no turns of is its summary. */
interface Recording extends Sampled {
  unit: Unit;
}

/** ponytail: a turn's characters, guessed before its words are read; the words read are then held to the budget. */
const TURN_CHARS = 120;

/** His recorded conversation-days among `units` (stored, not dropped, people as of today) where one of `refs` spoke. */
export const recordingsOf = (units: Unit[], refs: Set<string>) =>
  units.flatMap((u): Recording[] =>
    kindOf(u.source) === "voice" && u.people.some((p) => refs.has(p))
      ? [
          {
            day: u.date,
            eventful: u.stats.items,
            size: u.stats.items * TURN_CHARS,
            unit: u,
          },
        ]
      : []
  );

/**
 * The sampled recordings with their words (`spokenLines`), his and `refs`' turns only, days kept in order to `budget`
 * characters; a chapter's words too while lifelog holds its turns, else its title and summary as context, never quoted.
 */
export async function spokenOf(
  recordings: Recording[],
  refs: Set<string>,
  people: Pick<People, "resolve" | "truth">,
  named: (ref: string) => string,
  budget: number,
  open = openStore
) {
  const spoken = await spokenLines(
    recordings.map((r) => r.unit),
    people.resolve,
    people.truth,
    open
  );
  const hasWords = (u: Unit) => (spoken.get(u.id)?.length ?? 0) > 0;
  const live = recordings.flatMap((r) => (hasWords(r.unit) ? [r.unit] : []));
  let used = 0;
  // Newest first, as the sample keeps them: a low guess of their length cuts the oldest.
  const days = live.toReversed().flatMap((u): ShownDay[] => {
    const messages = betweenOf(
      spoken.get(u.id) ?? [],
      refs,
      (l) => l.speaker
    ).map((l) => ({
      at: l.at,
      deleted: false,
      fromMe: l.speaker === OWNER,
      text: l.text,
      who: named(l.speaker),
    }));
    const size = sizeOf(messages);
    if (messages.length === 0 || used + size > budget) {
      return [];
    }
    used += size;
    return [
      {
        day: u.date,
        eventful: messages.length,
        kind: "spoken",
        messages,
        size,
        source: u.source,
        with: [
          ...new Set(messages.flatMap((m) => (m.fromMe ? [] : [m.who]))),
        ].join(", "),
      },
    ];
  });
  const recorded = recordings.flatMap((r) =>
    isFrozen(r.unit) && !hasWords(r.unit)
      ? [{ day: r.day, summary: r.unit.summary, title: r.unit.title }]
      : []
  );
  return { days: days.toReversed(), recorded };
}

/** What passed between him and `refs` in one group chat-day or recording: his and their lines, when they said anything. */
export const betweenOf = <T>(
  list: T[],
  refs: Set<string>,
  speaker: (x: T) => string
) =>
  list.some((x) => refs.has(speaker(x)))
    ? list.filter((x) => speaker(x) === OWNER || refs.has(speaker(x)))
    : [];

/** His group chat-days: a chat its source calls a group (`isDirect`), never a 1:1 whose person is not known yet. */
export function groupDaysOf(
  events: SourceEvent[],
  said: Map<SourceEvent, string>
) {
  const chats = Map.groupBy(
    events.filter((e) => kindOf(e.source) === "chat"),
    (e) => `${e.source}|${e.chat}`
  ).values();
  const groups = [...chats].flatMap((list) => {
    const [first] = list;
    const others = new Set(
      list.flatMap((e) => (e.fromMe ? [] : [said.get(e)]))
    );
    return first && !isDirect(first.source, first.chat, others.size)
      ? list
      : [];
  });
  return [...Map.groupBy(groups, dayUnitId).values()];
}

const ReplyLine = z.object({
  facet: z.string(),
  kind: z.string().nullish(),
  quotes: z.array(z.string()).catch([]),
  source: z.string().nullish(),
  text: z.string(),
  writer: z.string().nullish(),
});

/**
 * The reply's lines, each quote kept only as words found in a chat message or a recorded turn the call was shown (a
 * mail's text holds quoted history), a writing line's only in that writer's own 1:1 chat messages (how he writes in a
 * group is not how he writes to them), with the message's time. A `source` not shown
 * is dropped; a line of no known shape goes.
 */
export function personaLines(reply: unknown, days: ShownDay[]) {
  const list = (reply as { lines?: unknown } | null)?.lines;
  const said = days.filter((d) => kindOf(d.source) !== "mail");
  const quotable = said.flatMap((d) => d.messages);
  const direct = said
    .filter((d) => d.kind === "direct" && kindOf(d.source) === "chat")
    .flatMap((d) => d.messages);
  const sources = new Set(
    days.flatMap((d) => (d.kind === "direct" ? [d.source] : []))
  );
  return (Array.isArray(list) ? list : []).flatMap((raw) => {
    const r = ReplyLine.safeParse(raw);
    if (!r.success) {
      return [];
    }
    const pool =
      r.data.facet === "writes"
        ? direct.filter((m) => m.fromMe === (r.data.writer === "owner"))
        : quotable;
    const texts = pool.map((m) => m.text);
    const quotes = r.data.quotes.flatMap((q) => {
      const found = locate(q, texts);
      const m = found ? pool[found.line] : undefined;
      return found && m ? [{ at: m.at, text: clip(found.verbatim, 200) }] : [];
    });
    const { facet, kind, source, text, writer } = r.data;
    const l = PersonaLine.safeParse({
      facet,
      quotes: quotes.slice(0, 4),
      text,
      ...(facet === "writes" && { kind: kind ?? null, writer }),
      ...(facet === "writes" &&
        source &&
        sources.has(source as SourceEvent["source"]) && { source }),
    });
    return l.success ? [l.data] : [];
  });
}

/** Whether a persona is due: none yet, or a week old with new messages behind it. */
export const isDue = (
  last: { built: string; inputs: string } | null,
  inputs: string,
  now: Date
) =>
  !last ||
  (last.inputs !== inputs &&
    now.getTime() - Date.parse(last.built) >= REBUILD_AFTER);

const readPage = async (ref: string) =>
  clip(
    await Bun.file(pagePath(ref))
      .text()
      .catch(() => ""),
    PAGE_MAX
  );

export async function personas({ events, failed, since }: WithPeople) {
  const step = await begin("persona", "main", { prompt: PERSONA_PROMPT });
  // His own writing, over the same years, for his own persona.
  const unread = [...failed];
  const own = (
    await Promise.all(
      Object.entries(tables().OWN_WRITING).map(([name, read]) =>
        safely(name, () => read(since), unread)
      )
    )
  ).flat();
  // A source that could not be read would look like they stopped writing there: nothing is written or removed.
  if (unread.length > 0) {
    return step.end({ unread, written: 0 });
  }
  const people = await readPeople();
  const paged = await pagedNow(people);
  const kept = events.filter((e) => !(isLifeOutput(e) || e.bulk));
  const direct = directChats(kept, people.resolve);
  const said = new Map(
    kept.map((e) => [e, speakerOf(kindOf(e.source), e, people.resolve)])
  );
  const named = (ref: string) => (ref === OWNER ? "him" : people.nameOf(ref));
  const whoOf = (e: SourceEvent) => named(said.get(e) ?? OWNER);
  const groupDays = groupDaysOf(kept, said);
  const groupsWith = (refs: Set<string>) =>
    shownDaysOf(
      groupDays.flatMap((list) =>
        betweenOf(list, refs, (e) => said.get(e) ?? "")
      ),
      "group",
      whoOf,
      (e) => `${e.chatName ?? e.chat} (group)`
    );
  const units = (await readUnits(localDate(since.toISOString()))).flatMap(
    (u) => (u.drop ? [] : [unitNow(u, people.refOf)])
  );
  const others = new Set([...paged].filter((ref) => ref !== OWNER));
  const targets = [...paged].flatMap((ref) => {
    // His own reads him with everyone who has a page, each day named by whom it is with.
    const refs = ref === OWNER ? others : new Set([ref]);
    const written = [...refs].flatMap((r) =>
      shownDaysOf(direct.get(r) ?? [], "direct", whoOf, () => people.nameOf(r))
    );
    const groups = groupsWith(refs);
    const writing =
      ref === OWNER
        ? shownDaysOf(
            own,
            "own_writing",
            () => named(OWNER),
            (e) => e.chatName ?? e.chat
          )
        : [];
    const recordings = recordingsOf(units, refs);
    return written.length + groups.length + writing.length + recordings.length >
      0
      ? [{ groups, recordings, ref, refs, writing, written }]
      : [];
  });
  let written = 0;
  await inBatches(targets, step.dir, (t, dir) =>
    step.attempt(
      async () => {
        // Everything, when it fits one call (it does today); else one sample across the years of all of it.
        const room = callCharsOf(step.llm);
        const sample = sampleOf<Recording | ShownDay>(
          [...t.written, ...t.groups, ...t.writing, ...t.recordings],
          room
        );
        const heard = sample.filter((d): d is Recording => "unit" in d);
        const days = sample.filter((d): d is ShownDay => "messages" in d);
        const counts: PairCounts | null =
          t.ref === OWNER ? null : pairCountsOf(direct.get(t.ref) ?? []);
        const shown = {
          counts,
          days: days.map(dayInput),
          heard: heard.map((r) => `${r.unit.id}:${r.unit.hash}`),
          person: t.ref === OWNER ? OWNER : people.nameOf(t.ref),
        };
        // What was said decides whether it is due, not the page (rewritten most nights); a recording's words are read
        // only then.
        const inputs = digest(
          "sha256",
          `${PERSONA_PROMPT}\n${JSON.stringify(shown)}`,
          16
        );
        if (!isDue(readPersona(t.ref), inputs, step.now)) {
          return;
        }
        const spoken = await spokenOf(
          heard,
          t.refs,
          people,
          named,
          room - days.reduce((n, d) => n + d.size, 0)
        );
        const all = [...days, ...spoken.days].toSorted((a, b) =>
          a.day.localeCompare(b.day)
        );
        // Nothing left to read (a recording whose turns were all someone else's): no call, nothing written.
        if (all.length === 0 && spoken.recorded.length === 0) {
          return;
        }
        const input = {
          counts,
          days: all.map(dayInput),
          page: await readPage(t.ref),
          person: shown.person,
          recorded: spoken.recorded,
        };
        const reply = await step.ask({
          context: meContext(people.truth),
          dir,
          input,
          prompt: PERSONA_PROMPT,
        });
        const lines = personaLines(reply, all);
        const gist = z
          .string()
          .trim()
          .min(1)
          .safeParse((reply as { gist?: unknown } | null)?.gist);
        // A reply with no line or no gist is a failed call: the last persona stays (one in an older shape is shown as none
        // until a run succeeds), the next run retries.
        if (lines.length === 0 || !gist.success) {
          throw new Error("no persona line or gist");
        }
        const persona: Persona = {
          built: step.now.toISOString(),
          gist: clip(gist.data, GIST_MAX),
          inputs,
          lines,
          madeBy: stamp(step.llm, PERSONA_PROMPT, step.run),
          page: t.ref,
          schemaVersion: 2,
        };
        await Bun.write(
          personaPath(t.ref),
          `${JSON.stringify(persona, null, 1)}\n`
        );
        written += 1;
      },
      { page: t.ref }
    )
  );
  // A persona whose person lost their page, or with whom nothing was written or said, goes.
  const gone = await removeAllBut(
    PERSONAS,
    new Set(targets.map((t) => personaPath(t.ref)))
  );
  return step.end({ gone, personas: targets.length, written });
}
