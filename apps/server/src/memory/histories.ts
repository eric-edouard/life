import { join } from "node:path";
import { z } from "zod";
import { readJson } from "../core/files";
import { callCharsOf, stamp } from "../models/llm";
import { QUOTE_CHARS } from "../records/fields";
import { History, type HistoryMonth, HistoryPart } from "../records/history";
import type { SourceEvent } from "../records/source";
import { directChats, pagedNow, type WithPeople } from "./closeness";
import { batchesOf, exchangesOf } from "./exchanges";
import { historyPath } from "./ledger";
import { foundQuotes } from "./observe";
import { begin, inBatches, inputsOf, type Step } from "./run";
import { clip } from "./units";
import type { People } from "./who";
import { batchLines } from "./words";
import { localDate } from "./zones";

// A history (docs/glossary.md): a person's past months with him, each summarised once from their one-to-one chats and
// mail threads (`directChats`, the stream the exchange counts count), and the story of the years. The present month
// is the situation's; a month is read again only when what it was shown changes (a late backup, a late mail). Stored
// in memory/histories/ (model output is expensive); what is pending is derived each night from the stored `inputs`.
// Off until his `history` setting names the month to start from.

const MONTH_PROMPT = "memory-history-month.v1";
const STORY_PROMPT = "memory-history-story.v1";
/** The most month calls one night makes: a first build of many years takes several nights, newest months first. */
const NIGHT_CALLS = 200;
/** What a call's reply is allowed, in tokens, for the count shown before a run. */
const REPLY_TOKENS = 600;

const monthOf = (at: string) => localDate(at).slice(0, 7);

/** One call of a month: what the model is shown, and the messages its quotes are looked for in. */
interface Call {
  input: {
    lines: string[];
    month: string;
    part: number;
    parts: number;
    with: string;
  };
  quotable: SourceEvent[];
}
/** A closed month between him and one person, as the calls that read it. */
export interface MonthCalls {
  calls: Call[];
  inputs: string;
  month: string;
}

/**
 * A person's one-to-one messages as the closed months to read, oldest first: each exchange in the local month it
 * starts in (`localDate`, the zone he was in), months before `from` and the month of `today` left out. A month with
 * nothing a model could quote (calls only) is no month: the exchange counts already show its calls.
 */
export function monthCallsOf(
  stream: SourceEvent[],
  name: string,
  o: { from: string; today: string }
): MonthCalls[] {
  const byMonth = Map.groupBy(exchangesOf(stream), (x) =>
    monthOf(x[0]?.at ?? "")
  );
  return [...byMonth]
    .filter(([month]) => month >= o.from && month < o.today.slice(0, 7))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([month, exchanges]) => {
      const said = exchanges.flat().filter((e) => !e.phoneCall);
      if (said.length === 0) {
        return [];
      }
      // The month's own exchanges, cut again the same way (the same quiet between them) into what one call reads.
      const batches = batchesOf(exchanges.flat());
      const calls = batches.map((batch, i) => {
        const shown = batchLines(batch, (e) => (e.fromMe ? "me" : name));
        return {
          input: {
            lines: shown.lines,
            month,
            part: i + 1,
            parts: batches.length,
            with: name,
          },
          quotable: shown.messages.filter((e) => !e.phoneCall),
        };
      });
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

/** Someone's history; an empty one when there is none or it is in another shape. */
export const readHistory = (ref: string): History =>
  History.safeParse(readJson(historyPath(ref))).data ?? {
    months: [],
    schemaVersion: 1,
    story: null,
  };

/** The pending months a night takes: the newest first across everyone, while their calls fit `cap`. */
export function newestWithin<P extends { m: MonthCalls }>(
  pending: P[],
  cap: number
) {
  const taken: P[] = [];
  let room = cap;
  for (const p of pending.toSorted((a, b) =>
    b.m.month.localeCompare(a.m.month)
  )) {
    if (p.m.calls.length <= room) {
      taken.push(p);
      room -= p.m.calls.length;
    }
  }
  return taken;
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
  o: { from: string; today: string }
) {
  if (failed.length > 0) {
    return null;
  }
  const direct = directChats(events, people.resolve);
  const paged = [...(await pagedNow(people))];
  const pending = paged.flatMap((ref) => {
    const name = people.nameOf(ref);
    const built = new Map(readHistory(ref).months.map((m) => [m.month, m]));
    return monthCallsOf(direct.get(ref) ?? [], name, o)
      .filter((m) => built.get(m.month)?.inputs !== m.inputs)
      .map((m) => ({ m, name, ref }));
  });
  const calls = pending.flatMap((p) => p.m.calls);
  const taken = newestWithin(pending, NIGHT_CALLS);
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

/** What the story call is shown: the months through the last closed year, each as its parts' summaries. */
export function storyInputOf(history: History, name: string, today: string) {
  const through = String(Number(today.slice(0, 4)) - 1);
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
  const reply = await step.ask({ dir, input, prompt: STORY_PROMPT });
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
      madeBy: stamp(step.llm, STORY_PROMPT, step.run),
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
              dir: join(dir, `${m.month}-${i + 1}`),
              input: call.input,
              prompt: MONTH_PROMPT,
            });
            parts.push(partOf(reply, call.quotable));
          }
          await write(
            t.ref,
            withMonth(readHistory(t.ref), {
              built: step.now.toISOString(),
              inputs: m.inputs,
              madeBy: stamp(step.llm, MONTH_PROMPT, step.run),
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
