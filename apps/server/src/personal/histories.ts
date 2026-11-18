import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { readJson } from "../core/files";
import { newestWithin, packed } from "../core/lists";
import { log } from "../core/log";
import type { SourceName } from "../core/names";
import { OWNER_DATA_DIR } from "../core/paths";
import {
  directChats,
  heardPersonOf,
  pagedNow,
  type WithPeople,
} from "../memory/closeness";
import {
  currentSummaries,
  type HeldSummary,
} from "../memory/conversation-summaries";
import {
  batchLines,
  charsOf,
  EXCHANGE_BATCH_CHARS,
  exchangesOf,
} from "../memory/exchanges";
import { historyPath } from "../memory/memory-files";
import { foundQuotes } from "../memory/quote-check";
import { begin, inBatches, inputsOf, readsOf, type Step } from "../memory/run";
import { dayUnitId } from "../memory/unit-ids";
import { clip } from "../memory/units";
import type { People } from "../memory/who";
import { localDate, time } from "../memory/zones";
import { callCharsOf } from "../models/llm";
import { IN_PERSON } from "../models/prompt-parts";
import { QUOTE_CHARS } from "../records/fields";
import { History, type HistoryMonth, HistoryPart } from "../records/history";
import type { SourceEvent } from "../records/source";

// A history (docs/glossary.md): a person's past months with him, each summarised once from their one-to-one chats and
// mail threads (`directChats`, the stream the exchange counts count), and the story of the years. The present month
// is the situation's; a month is read again only when what it was shown changes (a late backup, a late mail). Stored
// in memory/histories/ (model output is expensive); what is pending is derived each night from the stored `inputs`.
// Off until the `histories` add-on, whose `from` names the month to start from.

const MONTH_PROMPT = "memory-history-month.v1";
const STORY_PROMPT = "memory-history-story.v1";
/** The most month calls one night makes: a first build of many years takes several nights, newest months first. */
const NIGHT_CALLS = 200;
/** What a call's reply is allowed, in tokens, for the count shown before a run. */
const REPLY_TOKENS = 600;

const monthOf = (at: string) => localDate(at).slice(0, 7);

/** One call of a month: what the model is shown, its call parts, and the messages its quotes are looked for in. */
interface Call {
  callParts: string[];
  input: {
    lines: string[];
    month: string;
    part: number;
    parts: number;
    with: string;
  };
  quotable: SourceEvent[];
  /** The units the call is shown, as `readsOf` counts them. */
  shows: { source: SourceName | "memory"; unit: string }[];
}
/** A conversation he had in person with the person, as its summary shows it (`currentSummaries`). */
type InPerson = Pick<HeldSummary, "at" | "ref" | "summary">;
/** What a month reads, in time order: an exchange of their messages, or a conversation in person. */
type MonthItem =
  | { at: string; exchange: SourceEvent[] }
  | { at: string; ref: string; summary: string };

/** A batch of a month's items as the lines a call is shown: the exchanges numbered as `batchLines` numbers them, each conversation in person under its own heading. */
function itemLines(batch: MonthItem[], who: (e: SourceEvent) => string) {
  let n = 0;
  return batch.flatMap((item) => {
    if ("summary" in item) {
      return [
        `## In person · ${localDate(item.at)} ${time(item.at)}`,
        item.summary,
      ];
    }
    const { lines } = batchLines([item.exchange], who, n);
    n += item.exchange.length;
    return lines;
  });
}
/** A closed month between him and one person, as the calls that read it. */
export interface MonthCalls {
  calls: Call[];
  inputs: string;
  month: string;
}

/**
 * A person's one-to-one messages and conversations in person as the closed months to read, oldest first, each month's
 * in time order: each exchange in the local month it starts in (`localDate`, the zone he was in), months before `from`
 * and the month of `today` left out. A month with nothing a model could read (calls only) is no month: the exchange
 * counts already show its calls. A month with no conversation in person is shown exactly as before they were read, so
 * its stored reading stands.
 */
export function monthCallsOf(
  stream: SourceEvent[],
  name: string,
  o: { from: string; today: string },
  inPerson: InPerson[] = []
): MonthCalls[] {
  const items: MonthItem[] = [
    ...exchangesOf(stream).map((x) => ({ at: x[0]?.at ?? "", exchange: x })),
    ...inPerson.map((h) => ({ at: h.at, ref: h.ref, summary: h.summary })),
  ].toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const byMonth = Map.groupBy(items, (x) => monthOf(x.at));
  const who = (e: SourceEvent) => (e.fromMe ? "me" : name);
  return [...byMonth]
    .filter(([month]) => month >= o.from && month < o.today.slice(0, 7))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([month, all]) => {
      const isRead = all.some(
        (x) =>
          "summary" in x || x.exchange.some((e: SourceEvent) => !e.phoneCall)
      );
      if (!isRead) {
        return [];
      }
      // The month's items, packed into what one call reads.
      const batches = packed(all, EXCHANGE_BATCH_CHARS, (x) =>
        "summary" in x ? x.summary.length : charsOf(x.exchange)
      );
      const calls = batches.map((batch, i) => ({
        callParts: batch.some((x) => "summary" in x) ? [IN_PERSON] : [],
        input: {
          lines: itemLines(batch, who),
          month,
          part: i + 1,
          parts: batches.length,
          with: name,
        },
        quotable: batch.flatMap((x) =>
          "exchange" in x ? x.exchange.filter((e) => !e.phoneCall) : []
        ),
        shows: batch.flatMap((x): Call["shows"] =>
          "summary" in x
            ? [{ source: "memory" as const, unit: x.ref }]
            : x.exchange.map((e) => ({ source: e.source, unit: dayUnitId(e) }))
        ),
      }));
      return [
        {
          calls,
          inputs: inputsOf(
            MONTH_PROMPT,
            calls.map((c) => c.input)
          ),
          month,
        },
      ];
    });
}

/**
 * Someone's history: an empty one when there is no file; a file in a shape this code does not know (a month written by
 * a newer version, a damaged file) is an error naming the file and the month, never an empty history: the next write
 * would drop every stored month.
 */
export function readHistory(ref: string): History {
  const path = historyPath(ref);
  if (!existsSync(path)) {
    return { months: [], schemaVersion: 1, story: null };
  }
  const raw = readJson<{ months?: { month?: unknown }[] }>(path);
  const parsed = History.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  const at = parsed.error.issues[0]?.path;
  const month =
    at?.[0] === "months" ? raw?.months?.[Number(at[1])]?.month : undefined;
  throw new Error(
    `the history ${relative(OWNER_DATA_DIR, path)} is in a shape this version does not know${month ? ` (month ${String(month)})` : ""}`
  );
}

/** One person's months still to read, and whether the night's cap left some of them for a later night. */
interface PersonWork {
  isWhole: boolean;
  months: MonthCalls[];
  name: string;
  ref: string;
}
export type HistoryWork = Awaited<ReturnType<typeof readHistoryWork>>;

/**
 * What the histories have to read, from a read of every year (`readWithPeople(new Date(0))`): for whoever has a page,
 * the closed months from `from` on whose stored `inputs` differ from what would be shown now, the newest months first
 * across everyone, up to `NIGHT_CALLS` calls. Null when a source failed (a month must never be summarised without
 * one). `counts` is the whole of what is pending, before the cap: what a run would cost.
 */
export async function readHistoryWork(
  { events, failed }: Pick<WithPeople, "events" | "failed">,
  people: People,
  o: { from: string; today: string },
  readSummaries: () => Promise<HeldSummary[]> = currentSummaries
) {
  if (failed.length > 0) {
    return null;
  }
  const direct = directChats(events, people.resolve);
  // Each conversation in person under everyone heard in it (`heardPersonOf`).
  const inPerson = new Map<string, InPerson[]>();
  for (const h of await readSummaries()) {
    const refs = new Set(
      h.speakers.map((v) => heardPersonOf(people.resolve, v.id, v.name))
    );
    for (const ref of refs) {
      if (ref) {
        inPerson.set(ref, [...(inPerson.get(ref) ?? []), h]);
      }
    }
  }
  const everyone = [...(await pagedNow(people))];
  // A history in an unknown shape is logged once and left out of the work: no month of that person is read, so none is
  // written over it, and no story call fails for it again.
  const paged = everyone.filter((ref) => {
    try {
      readHistory(ref);
      return true;
    } catch (e) {
      log("run.error", { error: (e as Error).message, step: "memory.history" });
      return false;
    }
  });
  const pending = paged.flatMap((ref) => {
    const name = people.nameOf(ref);
    const built = new Map(readHistory(ref).months.map((m) => [m.month, m]));
    return monthCallsOf(direct.get(ref) ?? [], name, o, inPerson.get(ref))
      .filter((m) => built.get(m.month)?.inputs !== m.inputs)
      .map((m) => ({ m, name, ref }));
  });
  const calls = pending.flatMap((p) => p.m.calls);
  const taken = newestWithin(pending, NIGHT_CALLS, {
    at: (p) => p.m.month,
    size: (p) => p.m.calls.length,
  });
  const took = new Set(taken);
  const waiting = new Set(
    pending.filter((p) => !took.has(p)).map((p) => p.ref)
  );
  const mine = Map.groupBy(taken, (p) => p.ref);
  // Everyone with a page: one with no month to read may still owe a story (a year closed).
  const work: PersonWork[] = paged.map((ref) => ({
    isWhole: !waiting.has(ref),
    months: (mine.get(ref) ?? [])
      .map((p) => p.m)
      .toSorted((a, b) => a.month.localeCompare(b.month)),
    name: people.nameOf(ref),
    ref,
  }));
  return {
    counts: {
      calls: calls.length,
      months: pending.length,
      people: new Set(pending.map((p) => p.ref)).size,
      // A ceiling: the lines shown, at 3 characters a token, plus a full reply for each call.
      tokens: Math.round(
        calls.reduce((n, c) => n + c.input.lines.join("\n").length, 0) / 3 +
          calls.length * REPLY_TOKENS
      ),
    },
    today: o.today,
    work,
  };
}

/** Quotation marks: a summary holding any would carry words no check has seen. */
const QUOTE_MARKS = /["“”«»]/;

const Reply = z.object({
  quotes: z.array(z.string()).default([]),
  summary: z.string().trim().min(1),
});

/**
 * A month call's reply as its part: the summary, and only the quotes found in a message it was shown (`foundQuotes`),
 * each with its time and writer. A summary holding quotation marks is a failed call (its words would be unchecked); a
 * part with no quote is kept (a month of short messages has nothing long enough to find).
 */
export function partOf(reply: unknown, quotable: SourceEvent[]): HistoryPart {
  const r = Reply.parse(reply);
  if (QUOTE_MARKS.test(r.summary)) {
    throw new Error("quotation marks in a month's summary");
  }
  return HistoryPart.parse({
    quotes: foundQuotes(r.quotes, quotable)
      .slice(0, 4)
      .map((q) => ({
        at: q.message.at,
        text: clip(q.text, QUOTE_CHARS),
        writer: q.message.fromMe ? "owner" : "them",
      })),
    summary: r.summary,
  });
}

/** A history with one month read again: the month replaced whole, the months kept oldest first. */
export const withMonth = (history: History, month: HistoryMonth): History => ({
  ...history,
  months: [
    ...history.months.filter((m) => m.month !== month.month),
    month,
  ].toSorted((a, b) => a.month.localeCompare(b.month)),
});

const write = (ref: string, history: History) =>
  Bun.write(
    historyPath(ref),
    `${JSON.stringify(History.parse(history), null, 1)}\n`
  );

/**
 * What the story call is shown: the months through `through`, each as its parts' summaries. `through` is the year of the
 * newest month, at most the last closed year: the clock moving alone changes nothing; a story is retold only when a
 * month it does not hold exists.
 */
export function storyInputOf(history: History, name: string, today: string) {
  const newest = history.months.reduce(
    (a, m) => (m.month > a ? m.month : a),
    ""
  );
  const through = [newest.slice(0, 4), String(Number(today.slice(0, 4)) - 1)]
    .toSorted()
    .at(0) as string;
  return {
    months: history.months
      .filter((m) => m.month.slice(0, 4) <= through)
      .map((m) => ({
        month: m.month,
        summary: m.parts.map((p) => p.summary).join(" "),
      })),
    through,
    with: name,
  };
}

/** Whether a story is to be told: its months changed since the last one, there are some, and none of the person's months still waits. */
export const isStoryDue = (
  history: History,
  now: { inputs: string; months: number },
  isWhole: boolean
) => isWhole && now.months > 0 && history.story?.inputs !== now.inputs;

/**
 * The story of the years, built when its months changed (a year closed, or an old month was read again) and never
 * while some of the person's months still wait: it would be told from half a history.
 * ponytail: no year level; months that do not fit one call leave no story (logged), a year's summary when one does.
 */
async function tellStory(
  step: Step,
  t: PersonWork,
  today: string,
  dir: string
) {
  const history = readHistory(t.ref);
  const input = storyInputOf(history, t.name, today);
  const inputs = inputsOf(STORY_PROMPT, input);
  if (
    !isStoryDue(history, { inputs, months: input.months.length }, t.isWhole)
  ) {
    return false;
  }
  if (JSON.stringify(input).length > callCharsOf(step.llm)) {
    step.error("the months do not fit one story call", { page: t.ref });
    return false;
  }
  const reply = await step.ask({
    dir,
    input,
    prompt: STORY_PROMPT,
    reads: readsOf(
      input.months.map((m) => ({
        source: "memory",
        unit: `${t.ref}:${m.month}`,
      }))
    ),
  });
  const text = z
    .string()
    .trim()
    .min(1)
    .parse((reply as { story?: unknown } | null)?.story);
  // The months it read hold no checked quote: words in quotation marks would be made up.
  if (QUOTE_MARKS.test(text)) {
    throw new Error("quotation marks in a story");
  }
  await write(t.ref, {
    ...readHistory(t.ref),
    story: {
      built: step.now.toISOString(),
      inputs,
      madeBy: step.madeBy(STORY_PROMPT),
      text: clip(text, 6000),
      through: input.through,
    },
  });
  return true;
}

/**
 * Reads the pending months (`readHistoryWork`), a few people at a time, each person's months in order: a month is
 * written when every one of its calls gave a part, else its last version stands and the next night reads it again.
 * Then each person's story. A failure costs its month only, never the night.
 */
export async function histories(pending: NonNullable<HistoryWork>) {
  const step = await begin("history", "main", { prompt: MONTH_PROMPT });
  let months = 0;
  let stories = 0;
  await inBatches(pending.work, step, async (t, dir) => {
    let isRead = true;
    for (const m of t.months) {
      // biome-ignore lint/performance/noAwaitInLoops: one person's file is written one month at a time
      const done = await step.attempt(
        async () => {
          const parts: HistoryPart[] = [];
          for (const [i, call] of m.calls.entries()) {
            // biome-ignore lint/performance/noAwaitInLoops: a month's parts in order, a failed one ends the month
            const reply = await step.ask({
              callParts: call.callParts,
              dir: join(dir, `${m.month}-${i + 1}`),
              input: call.input,
              prompt: MONTH_PROMPT,
              reads: readsOf(call.shows),
            });
            parts.push(partOf(reply, call.quotable));
          }
          await write(
            t.ref,
            withMonth(readHistory(t.ref), {
              built: step.now.toISOString(),
              inputs: m.inputs,
              madeBy: step.madeBy(MONTH_PROMPT, [
                ...new Set(m.calls.flatMap((c) => c.callParts)),
              ]),
              month: m.month,
              parts,
            })
          );
          months += 1;
          return true;
        },
        { month: m.month, page: t.ref }
      );
      isRead &&= !!done;
    }
    // A month that failed tonight still waits: no story from half a history.
    const isWhole = t.isWhole && isRead;
    const told = await step.attempt(
      () =>
        tellStory(step, { ...t, isWhole }, pending.today, join(dir, "story")),
      { page: t.ref }
    );
    stories += told ? 1 : 0;
  });
  return step.end({ months, stories });
}
