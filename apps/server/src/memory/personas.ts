import { z } from "zod";
import { DAY, daysBefore, HOUR, MIN } from "../core/clock";
import { readJson, removeAllBut } from "../core/files";
import { digest } from "../core/hash";
import { stamp } from "../models/llm";
import { Persona, PersonaLine, type PersonaQuote } from "../records/persona";
import type { SourceEvent } from "../records/source";
import { directChats, pagedNow, type WithPeople } from "./closeness";
import { PERSONAS, pagePath, personaPath } from "./ledger";
import { locate } from "./observe";
import { OWNER } from "./read-truth";
import { begin, inBatches, meContext } from "./run";
import { kindOf } from "./sources";
import { clip, isLifeOutput } from "./units";
import { readPeople } from "./who";
import { messageLine } from "./words";
import { localDate, time } from "./zones";

// `bun life memory personas`: what each person with a page is like, what keeps happening between them and the owner,
// and how each writes to the other (docs/architecture.md, "The pipeline"); his own across everyone. One call per person
// reads their 1:1 messages both ways (the night's `readWithPeople`: 3 years), sampled across the years (`sampleOf`),
// with their page and code's counts (`pairCountsOf`), and writes the persona whole, at most once a week and only when
// something new was written. Every quote is checked against the messages shown. Nothing is sent.

const PERSONA_PROMPT = "memory-persona.v1";
/** Characters of messages a persona reads: enough days across the years to see what repeats. */
const BUDGET = 100_000;
/** Characters of a message shown (a mail's body runs long) and of their page. */
const MESSAGE_MAX = 1500;
const PAGE_MAX = 20_000;
/** How old a persona gets before new messages rebuild it: people change slowly, a call a night per person would not. */
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

const readPersona = (ref: string) => {
  const p = Persona.safeParse(readJson(personaPath(ref)));
  return p.success ? p.data : null;
};

/** A persona's lines a reader shows; none when there is none. */
export const readPersonaLines = (ref: string) => readPersona(ref)?.lines ?? [];

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

/**
 * Persona lines as a reader shows them: the readings under Persona, each with its support; the writing lines under
 * Communication style (the connector's word for them). Nothing when there is none.
 */
export function personaBlock(lines: PersonaLine[], today: string) {
  const readings = lines.flatMap((l) => (l.facet === "writes" ? [] : [l]));
  const writes = lines.flatMap((l) => (l.facet === "writes" ? [l] : []));
  return [
    ...(readings.length > 0
      ? [
          `Persona (what they are like and what keeps happening between them and him, read weekly from 3 years of their 1:1 messages; solid: seen on ${SOLID_DAYS} days or more, thin: fewer, old: not seen for a year):`,
          ...readings.map(
            (l) =>
              `- ${l.facet} (${supportOf(l.quotes, today)}): ${l.text}${quoted(l.quotes)}`
          ),
          "",
        ]
      : []),
    ...(writes.length > 0
      ? [
          "Communication style (how he writes to them and they to him, read weekly; follow his when drafting for him):",
          ...writes.map(
            (l) =>
              `- ${l.writer === "owner" ? "he writes" : "they write"}${l.kind ? `, ${l.kind}` : ""}${l.source ? ` (${l.source})` : ""}: ${l.text}${quoted(l.quotes)}`
          ),
          "",
        ]
      : []),
  ];
}

/** One message as the persona call is shown it. */
interface Shown {
  at: string;
  deleted: boolean;
  fromMe: boolean;
  source: SourceEvent["source"];
  text: string;
}

/** One day of one chat or mail thread shown: with whom, its messages. */
interface ShownDay {
  day: string;
  messages: Shown[];
  source: SourceEvent["source"];
  with: string;
}

const sizeOf = (d: ShownDay) =>
  d.messages.reduce((n, m) => n + m.text.length + 20, 0);
/** A day that says more: many messages, and more again for each one deleted. */
const eventful = (d: ShownDay) =>
  d.messages.length + 5 * d.messages.filter((m) => m.deleted).length;

/**
 * The days a persona reads, oldest first, to `budget` characters: the newest fifth, then the rest shared evenly by year,
 * each month's most eventful day in turn, so what keeps repeating shows across the years.
 */
export function sampleOf(
  events: SourceEvent[],
  withOf: (e: SourceEvent) => string,
  budget = BUDGET
) {
  const days = [
    ...Map.groupBy(
      events.toSorted((a, b) => a.at.localeCompare(b.at)),
      (e) => `${localDate(e.at)}|${e.source}|${e.chat}`
    ).values(),
  ]
    .map(
      (list): ShownDay => ({
        day: localDate((list[0] as SourceEvent).at),
        messages: list.map((e) => ({
          at: e.at,
          deleted: !!e.deleted,
          fromMe: e.fromMe,
          source: e.source,
          text: e.text.slice(0, MESSAGE_MAX),
        })),
        source: (list[0] as SourceEvent).source,
        with: withOf(list[0] as SourceEvent),
      })
    )
    .toSorted((a, b) => b.day.localeCompare(a.day));
  const taken = new Set<ShownDay>();
  let used = 0;
  const take = (list: ShownDay[], upTo: number) => {
    for (const d of list) {
      if (!taken.has(d) && used + sizeOf(d) <= upTo) {
        taken.add(d);
        used += sizeOf(d);
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
      a.reduce((n, d) => n + sizeOf(d), 0) -
      b.reduce((n, d) => n + sizeOf(d), 0)
  );
  for (const [i, year] of years.entries()) {
    // Each month's most eventful day in turn, then each month's next: eventful days, spread across the year.
    const months = [
      ...Map.groupBy(year, (d) => d.day.slice(0, 7)).values(),
    ].map((m) => m.toSorted((a, b) => eventful(b) - eventful(a)));
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

/** The day as the prompt reads it: each message `HH:MM him|<name>: text[ (deleted)]`. */
const linesOf = (d: ShownDay) =>
  d.messages.map((m) =>
    messageLine(time(m.at), m.fromMe ? "him" : d.with, m.text, m.deleted)
  );

const ReplyLine = z.looseObject({
  facet: z.string(),
  quotes: z.array(z.string()).catch([]),
  source: z.string().nullish(),
  writer: z.string().nullish(),
});

/**
 * The reply's lines, each quote kept only as words found in a chat message the call was shown (a mail's text holds
 * quoted history), a writing line's only in that writer's own messages, with the message's time. A `source` not shown
 * is dropped; a line of no known shape goes.
 */
export function personaLines(reply: unknown, days: ShownDay[]) {
  const list = (reply as { lines?: unknown } | null)?.lines;
  const chat = days
    .flatMap((d) => d.messages)
    .filter((m) => kindOf(m.source) === "chat");
  const sources = new Set(days.map((d) => d.source));
  return (Array.isArray(list) ? list : []).flatMap((raw) => {
    const r = ReplyLine.safeParse(raw);
    if (!r.success) {
      return [];
    }
    const pool =
      r.data.facet === "writes"
        ? chat.filter((m) => m.fromMe === (r.data.writer === "owner"))
        : chat;
    const texts = pool.map((m) => m.text);
    const quotes = r.data.quotes.flatMap((q) => {
      const found = locate(q, texts);
      const m = found ? pool[found.line] : undefined;
      return found && m ? [{ at: m.at, text: clip(found.verbatim, 200) }] : [];
    });
    const { source, ...rest } = r.data;
    const l = PersonaLine.safeParse({
      ...rest,
      quotes: quotes.slice(0, 4),
      ...(source && sources.has(source as SourceEvent["source"])
        ? { source }
        : {}),
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

export async function personas({ events, failed }: WithPeople) {
  const step = await begin("persona", "main", { prompt: PERSONA_PROMPT });
  // A source that could not be read would look like they stopped writing there: nothing is written or removed.
  if (failed.length > 0) {
    return step.end({ unread: failed, written: 0 });
  }
  const people = await readPeople();
  const paged = await pagedNow(people);
  const kept = events.filter((e) => !(e.bulk || isLifeOutput(e)));
  const direct = directChats(kept, people.resolve);
  const nameOf = (ref: string) => people.names.get(ref) ?? ref;
  // His own reads his 1:1 messages with everyone who has a page, each day named by whom it is with.
  const withPaged = [...paged].flatMap((ref) =>
    (direct.get(ref) ?? []).map((e) => ({ e, ref }))
  );
  const withRef = new Map(withPaged.map(({ e, ref }) => [e, ref]));
  const targets = [...paged].flatMap((ref) => {
    const list =
      ref === OWNER ? withPaged.map((x) => x.e) : (direct.get(ref) ?? []);
    return list.some((e) => e.fromMe) ? [{ list, ref }] : [];
  });
  let written = 0;
  await inBatches(targets, step.dir, (t, dir) =>
    step.attempt(
      async () => {
        const days = sampleOf(t.list, (e) =>
          nameOf(t.ref === OWNER ? (withRef.get(e) ?? "") : t.ref)
        );
        const counts: PairCounts | null =
          t.ref === OWNER ? null : pairCountsOf(t.list);
        const shown = {
          counts,
          days: days.map((d) => ({
            day: d.day,
            lines: linesOf(d),
            source: d.source,
            with: d.with,
          })),
          person: t.ref === OWNER ? OWNER : nameOf(t.ref),
        };
        // The messages decide whether it is due, not the page: a page is rewritten most nights.
        const inputs = digest(
          "sha256",
          `${PERSONA_PROMPT}\n${JSON.stringify(shown)}`,
          16
        );
        if (!isDue(readPersona(t.ref), inputs, step.now)) {
          return;
        }
        const input = { ...shown, page: await readPage(t.ref) };
        const reply = await step.ask({
          context: meContext(people.truth),
          dir,
          input,
          prompt: PERSONA_PROMPT,
        });
        const lines = personaLines(reply, days);
        // A reply with no line is a failed call: the last persona stays, the next run retries.
        if (lines.length === 0) {
          throw new Error("no persona line");
        }
        const persona: Persona = {
          built: step.now.toISOString(),
          inputs,
          lines,
          madeBy: stamp(step.llm, PERSONA_PROMPT, step.run),
          page: t.ref,
          schemaVersion: 1,
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
  // A persona whose person lost their page, or he no longer writes to, goes.
  const gone = await removeAllBut(
    PERSONAS,
    new Set(targets.map((t) => personaPath(t.ref)))
  );
  return step.end({ gone, personas: targets.length, written });
}
