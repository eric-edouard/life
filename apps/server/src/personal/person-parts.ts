import { hasAddOn } from "../core/add-ons";
import { HOUR } from "../core/clock";
import {
  type ExchangeCounts,
  pairCountsOf,
  readExchangeCounts,
} from "../memory/exchange-counts";
import { EXCHANGE_ENDS_AFTER } from "../memory/exchanges";
import {
  type Dated,
  ending,
  evidenceRead,
  orNone,
  type PartInputs,
  type PersonalParts,
  paged,
  person,
  readOf,
} from "../memory/read-person-page";
import { dayNow, localDate, monthsOf } from "../memory/zones";
import type { History } from "../records/history";
import { readHistory } from "./histories";
import { personaBlock, readPersona } from "./personas";

// A person's read, the parts the add-ons supply (`personas`: `persona`; `histories`: `story`, `year`, `month`), and the
// one `readPerson` the connector and the command call: memory's `person` handed the parts whose add-on is on.

/** The first line of a month's or year's heading, as `year` and `month` parts show it. */
const HISTORY_ABOUT =
  "Past months between them and him (Life's history: each closed month of their one-to-one chats and mail, summarised by a model, quotes checked; not groups, recordings or what was said on calls)";

/** The years a person has anything in (a month read, a day of evidence, a unit held), newest first, each with its next read. */
function yearReads(o: PartInputs, months: Dated[]) {
  const years = [
    ...new Set([
      ...[...months, ...o.timeline].map((t) => t.day.slice(0, 4)),
      ...o.heldYears,
    ]),
  ].toSorted((a, b) => b.localeCompare(a));
  return years.map((y) =>
    readOf(o)(
      { part: "year", span: y },
      `${y}: its months' summaries, and what Life holds by month`
    )
  );
}

export function storyLines(
  history: History,
  exchange: Parameters<typeof exchangeCountsBlock>[0],
  o: PartInputs
) {
  const months = historyOf(history);
  const { story } = history;
  return [
    ...(months.length > 0 ? [HISTORY_ABOUT] : []),
    ...(story
      ? [`Over the years (through ${story.through}): ${story.text}`, ""]
      : []),
    ...exchangeCountsBlock(exchange),
    ...o.held({ sourcesOnly: true }),
    ...ending(yearReads(o, months)),
  ];
}

export function yearLines(history: History, o: PartInputs) {
  const months = historyOf(history);
  const read = readOf(o);
  const span = o.span as string;
  const held = o.held({ span });
  const mine = months.filter((m) => m.day.startsWith(span));
  const { next, taken } = paged(o, mine, o.before ? [] : held);
  const heading = o.before ? `, before ${o.before}` : "";
  return [
    mine.length > 0
      ? `Months of ${span}, newest first${heading}:`
      : `(no month of ${span} was read yet)`,
    ...taken.map((m) => m.line),
    ...(o.before ? [] : ["", ...held]),
    ...ending([
      ...taken.map((m) =>
        read({ part: "month", span: m.day.slice(0, 7) }, "its words and days")
      ),
      ...(next
        ? [read({ before: next, part: "year", span }, "older months")]
        : []),
      evidenceRead(o, span),
    ]),
  ];
}

const quoteLine = (q: { at: string; text: string; writer: "owner" | "them" }) =>
  `- "${q.text}" (${localDate(q.at)}, ${q.writer === "owner" ? "him" : "them"})`;

/** A month: the words found in it, and which days hold something. */
export function monthLines(history: History, o: PartInputs) {
  const span = o.span as string;
  const row = history.months.find((m) => m.month === span);
  const quotes = (row?.parts ?? []).flatMap((p) => p.quotes).map(quoteLine);
  const days = [
    ...Map.groupBy(
      o.timeline.filter((t) => t.day.startsWith(span)),
      (t) => t.day
    ),
  ]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([d, list]) => {
      const kinds = [...Map.groupBy(list, (t) => t.kind)].map(
        ([k, l]) => `${l.length} ${k}${l.length === 1 ? "" : "s"}`
      );
      return `- ${d}: ${kinds.join(", ")}`;
    });
  let words = [`(no history of ${span} was read yet)`];
  if (row) {
    words = [
      `Their words in ${span} (the month's summary is in ${span.slice(0, 4)}):`,
      ...(quotes.length > 0 ? quotes : ["(none found)"]),
    ];
  }
  return [
    ...words,
    "",
    `Days with evidence in ${span}:`,
    ...orNone(days),
    ...ending([
      evidenceRead(o, span),
      readOf(o)(
        { part: "year", span: span.slice(0, 4) },
        `${span.slice(0, 4)}: its months' summaries`
      ),
    ]),
  ];
}

/**
 * A person's history (`histories.ts`) as dated entries: each month's summary, on the month's last day (the paging's
 * key), newest first. Its words are the month part's. Nothing when no month was read yet.
 */
export function historyOf(history: History) {
  return history.months.toReversed().map(
    (m): Dated => ({
      // The month's last day: `monthsOf` ends a month's window there.
      day: monthsOf({ from: `${m.month}-01`, to: `${m.month}-31` })[0]
        ?.to as string,
      kind: "month",
      line: `- ${m.month}: ${m.parts.map((p) => p.summary).join(" ")}`,
    })
  );
}

/**
 * What code counts between him and one person (`exchange-counts.ts`): all years, then each year an exchange started
 * in, newest first. Nothing when none was counted (no file yet, or no one-to-one exchange with them): never zeros.
 */
export function exchangeCountsBlock(
  counted: { built: string; rows: ExchangeCounts[]; sources: string[] } | null
) {
  if (!counted || counted.rows.length === 0) {
    return [];
  }
  const answer = (minutes: number | null) =>
    minutes === null ? "none" : `${minutes} min`;
  const counts = (label: string, rows: ExchangeCounts[]) => {
    const c = pairCountsOf(rows);
    return `- ${label}: messages on ${c.days} days; he sent ${c.sent} (${c.sentDeleted} deleted), they sent ${c.got} (${c.gotDeleted} deleted); exchanges opened: he ${c.heOpened}, they ${c.theyOpened}; median answer: he ${answer(c.heAnswersIn)}, they ${answer(c.theyAnswerIn)}`;
  };
  const years = [
    ...Map.groupBy(counted.rows, (r) => localDate(r.start).slice(0, 4)),
  ].sort(([a], [b]) => b.localeCompare(a));
  return [
    `Counted by code between them and him, through ${localDate(counted.built)} (their one-to-one chats and mail threads: ${counted.sources.join(", ")}; not groups nor recordings; a call counts as a message; an exchange lasts until ${EXCHANGE_ENDS_AFTER / HOUR} hours of quiet and is opened by whoever writes first):`,
    counts("all years", counted.rows),
    ...years.map(([year, rows]) => counts(year, rows)),
    "",
  ];
}

/** The persona part: its block, and the reads after it (the story only where the story is offered). */
export const personaPartLines = (block: string[], o: PartInputs) => [
  ...orEmpty(block, "persona"),
  ...ending([
    ...(o.offers.some((r) => r.part === "story")
      ? [readOf(o)({ part: "story" }, "the years between them")]
      : []),
    evidenceRead(o),
  ]),
];

const orEmpty = (lines: string[], what: string) =>
  lines.length > 0 ? lines : [`(no ${what} yet)`];

/** A part made from a person's history; a history in a shape this version does not know throws, and the read says so. */
const historyPart = (
  lines: (history: History, o: PartInputs) => string[],
  about?: string
) => ({
  about,
  build: (ref: string) => {
    const history = readHistory(ref);
    return (o: PartInputs) => lines(history, o);
  },
});

/** The parts whose add-on is on. */
export function personalParts(): PersonalParts {
  return {
    ...(hasAddOn("personas")
      ? {
          persona: {
            about: "what they are like",
            build: (ref: string) => {
              const block = personaBlock(readPersona(ref), dayNow());
              return (o: PartInputs) => personaPartLines(block, o);
            },
          },
        }
      : {}),
    ...(hasAddOn("histories")
      ? {
          month: historyPart(monthLines),
          story: {
            about: "the years between them: story, counts, what Life holds",
            build: (ref: string) => {
              const history = readHistory(ref);
              const counted = readExchangeCounts();
              const rows = counted && {
                ...counted,
                rows: counted.people[ref] ?? [],
              };
              return (o: PartInputs) => storyLines(history, rows, o);
            },
          },
          year: historyPart(yearLines),
        }
      : {}),
  };
}

/** A person's read as the connector and the command give it: the core parts, and those of the add-ons that are on. */
export const readPerson = (
  name?: string,
  o: { before?: string; byId?: boolean; part?: string; span?: string } = {}
) => person(name, o, personalParts());
