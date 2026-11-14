import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { daysBefore } from "../core/clock";
import { readJson } from "../core/files";
import { newestWithin, within } from "../core/lists";
import { log } from "../core/log";
import { isHis, OWNER_DATA_DIR } from "../core/paths";
import { CHARS_PER_TOKEN, callCharsOf, stamp } from "../models/llm";
import {
  FULL_TEXT_CHARS,
  fullTextOf,
  History,
  type HistoryMonth,
} from "../records/history";
import { TOP_AT } from "../records/unit";
import { withStore } from "../sources/lifelog";
import { pagedNow } from "./closeness";
import { episodesWhere, historyPath, readIndex } from "./memory-files";
import { readMentions } from "./mentions";
import {
  episodesOf,
  mentionsByUnit,
  type TimelineEntry,
  talkedAbout,
  timelineOf,
} from "./person-timeline";
import { PART_CHARS } from "./read-part";
import { begin, inBatches, inputsOf, type Step } from "./run";
import { clip } from "./units";
import type { People } from "./who";
import { isDay } from "./zones";

// A history (docs/glossary.md): a person's past months with him, each written once from all their evidence of the month
// (their timeline: observations, episodes, recorded conversations) in two sizes, a full text of sentences each with the
// days it rests on and a headline, and the story of the years. The present month is the situation's; a month is read
// again only when what it was shown changes (a late backup, a late mail). Stored in memory/histories/ (model output is
// expensive); what is pending is derived each night from the stored `inputs`. Off until his `history` setting names
// the month to start from.

const MONTH_PROMPT = "memory-history-month.v2";
const STORY_PROMPT = "memory-history-story.v1";
/** The most month calls one night makes: a first build of many years takes several nights, newest months first. */
const NIGHT_CALLS = 200;
/** What a call's reply is allowed, in tokens, for the count shown before a run. */
const REPLY_TOKENS = 1500;
/** The most characters of evidence one month call is shown. */
const MONTH_INPUT_CHARS = 150_000;

/** What a month call is shown: the days that hold evidence, oldest first, each with its lines most important first. */
interface MonthInput {
  days: { day: string; lines: string[] }[];
  leftOut: number;
  month: string;
  with: string;
}
/** A closed month to read: what it is shown, its key, and every local day of it a shown line covers. */
export interface MonthRead {
  input: MonthInput;
  inputs: string;
  month: string;
  shownDays: string[];
}

/** An entry as a month call sees it: `!` first for top importance, an episode's `what` after its line. */
const shownLine = (e: TimelineEntry) =>
  `${e.importance >= TOP_AT ? "! " : ""}${e.line}${e.what ? ` What happened: ${e.what}` : ""}`;

/** Every day of `month` an entry covers (an episode's whole span). */
function coveredDays(e: TimelineEntry, month: string) {
  const days: string[] = [];
  for (let d = e.day; d <= e.to && d.startsWith(month); d = daysBefore(d, -1)) {
    days.push(d);
  }
  return days;
}

/**
 * A month of a person's timeline as a call is shown it, or null when it is no month: no entry, or all its lines fit
 * one read part (`PART_CHARS`, the agent reads the evidence itself). The entries as they stood, ranked by importance
 * then day; kept while they fit `MONTH_INPUT_CHARS`, the rest counted in `leftOut`. The key (`inputs`) is the evidence
 * shown and nothing else: no date, no later status.
 * ponytail: over the budget the least important lines go, a level's last days first; read a month in parts if the
 * count ever shows months cut.
 */
export function monthInputOf(
  timeline: TimelineEntry[],
  month: string,
  name: string
): MonthRead | null {
  const size = (e: TimelineEntry) => shownLine(e).length + 1;
  const entries = timeline.filter((e) => e.day.startsWith(month));
  if (within(entries, PART_CHARS, size).length === entries.length) {
    return null;
  }
  const ranked = entries.toSorted(
    (a, b) =>
      b.importance - a.importance ||
      a.day.localeCompare(b.day) ||
      a.line.localeCompare(b.line)
  );
  const kept = within(ranked, MONTH_INPUT_CHARS, size);
  const input: MonthInput = {
    days: [...Map.groupBy(kept, (e) => e.day)]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([day, list]) => ({ day, lines: list.map(shownLine) })),
    leftOut: ranked.length - kept.length,
    month,
    with: name,
  };
  return {
    input,
    inputs: inputsOf(MONTH_PROMPT, input),
    month,
    shownDays: [...new Set(kept.flatMap((e) => coveredDays(e, month)))],
  };
}

/** The closed months of a timeline to read, oldest first: months before `from` and the month of `today` left out. */
export const monthsToReadOf = (
  timeline: TimelineEntry[],
  name: string,
  o: { from: string; today: string }
) =>
  [...new Set(timeline.map((e) => e.day.slice(0, 7)))]
    .filter((month) => month >= o.from && month < o.today.slice(0, 7))
    .toSorted()
    .flatMap((month) => monthInputOf(timeline, month, name) ?? []);

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
  months: MonthRead[];
  name: string;
  ref: string;
}
export type HistoryWork = NonNullable<
  Awaited<ReturnType<typeof readHistoryWork>>
>;

/** Whether `--today` may be given: never on his own data (the present month closes only on a copy). */
export function todayOf(flag: string | undefined, now: string, his = isHis()) {
  if (flag === undefined) {
    return now;
  }
  if (his) {
    throw new Error("--today is refused on his own data: use a copy");
  }
  if (!isDay(flag)) {
    throw new Error(`--today "${flag}" is not a day (YYYY-MM-DD)`);
  }
  return flag;
}

/**
 * The rule of what is read: for each person the months whose stored `inputs` (`built`) differ from what would be shown
 * now, the newest months first across everyone, up to `calls` calls (a call a month). `counts` is the whole of what is
 * pending, before the cap: what a run would cost; `largest` the biggest input in tokens (a ceiling) and `cut` the
 * months whose evidence went over what one call is shown.
 */
export function historyWorkOf(
  persons: {
    built: Map<string, string>;
    months: MonthRead[];
    name: string;
    ref: string;
  }[],
  calls: number,
  today: string
) {
  const pending = persons.flatMap((p) =>
    p.months
      .filter((m) => p.built.get(m.month) !== m.inputs)
      .map((m) => ({ m, name: p.name, ref: p.ref }))
  );
  const taken = newestWithin(pending, calls, {
    at: (p) => p.m.month,
    size: () => 1,
  });
  const took = new Set(taken);
  const waiting = new Set(
    pending.filter((p) => !took.has(p)).map((p) => p.ref)
  );
  const mine = Map.groupBy(taken, (p) => p.ref);
  const tokens = (m: MonthRead) =>
    Math.ceil(JSON.stringify(m.input).length / CHARS_PER_TOKEN);
  // Everyone with a page: one with no month to read may still owe a story (a year closed).
  const work: PersonWork[] = persons.map((p) => ({
    isWhole: !waiting.has(p.ref),
    months: (mine.get(p.ref) ?? [])
      .map((x) => x.m)
      .toSorted((a, b) => a.month.localeCompare(b.month)),
    name: p.name,
    ref: p.ref,
  }));
  return {
    counts: {
      calls: pending.length,
      cut: pending.filter((p) => p.m.input.leftOut > 0).length,
      largest: Math.max(0, ...pending.map((p) => tokens(p.m))),
      months: pending.length,
      people: new Set(pending.map((p) => p.ref)).size,
      // A ceiling: the evidence shown, at `CHARS_PER_TOKEN`, plus a full reply for each call.
      tokens: pending.reduce((n, p) => n + tokens(p.m) + REPLY_TOKENS, 0),
    },
    today,
    work,
  };
}

/**
 * What the histories have to read: for whoever has a page, their closed months from `from` on, written from their
 * timeline in the index (`timelineOf`, observations as they stood), the rule in `historyWorkOf`. Null when the index is
 * not built. A person whose history is in an unknown shape is logged once and left out: no month of theirs is read,
 * so none is written over it, and no story call fails for it again.
 */
export async function readHistoryWork(
  people: People,
  {
    calls = NIGHT_CALLS,
    from,
    today,
  }: { calls?: number; from: string; today: string }
) {
  const all = await episodesWhere(() => true);
  const talked = talkedAbout(all, people, mentionsByUnit(readMentions()));
  const paged: { built: Map<string, string>; ref: string }[] = [];
  for (const ref of await pagedNow(people)) {
    try {
      paged.push({
        built: new Map(readHistory(ref).months.map((m) => [m.month, m.inputs])),
        ref,
      });
    } catch (e) {
      log("run.error", { error: (e as Error).message, step: "memory.history" });
    }
  }
  const persons = await withStore((store) =>
    readIndex((db) =>
      paged.map((p) => {
        const name = people.nameOf(p.ref);
        const lifelog = people.truth.people.find(
          (t) => `person:${t.id}` === p.ref
        )?.handles.lifelog;
        const timeline = timelineOf(
          db,
          store,
          p.ref,
          episodesOf(all, p.ref, people.refOf, talked),
          lifelog ? [lifelog] : [],
          true
        );
        return {
          ...p,
          months: monthsToReadOf(timeline, name, { from, today }),
          name,
        };
      })
    )
  );
  return persons && historyWorkOf(persons, calls, today);
}

/** Quotation marks: a text holding any would carry words no check has seen. */
const QUOTE_MARKS = /["“”«»]/;

const Reply = z.object({
  headline: z.string().trim().min(1).max(300),
  sentences: z.array(
    z.object({ days: z.array(z.string()), text: z.string().trim() })
  ),
});

/** What a month's reply lost to the checks, by reason. */
interface Dropped {
  days: number;
  length: number;
  quotes: number;
  size: number;
}

/**
 * A month call's reply as the month's two sizes, checked against what it was shown (`shownDays`, every day a shown line
 * covers): each sentence keeps only its days that were shown, and is dropped, never moved to another day, when none is
 * left, when it holds quotation marks, or when it would pass the size of a full text (counted by reason). A headline
 * holding quotation marks, or no sentence left, is a failed call: the month's last version stands.
 */
export function twoSizesOf(reply: unknown, shownDays: ReadonlySet<string>) {
  const r = Reply.parse(reply);
  if (QUOTE_MARKS.test(r.headline)) {
    throw new Error("quotation marks in a month's headline");
  }
  const dropped: Dropped = { days: 0, length: 0, quotes: 0, size: 0 };
  const sentences: { days: string[]; text: string }[] = [];
  let chars = 0;
  for (const s of r.sentences) {
    const days = [
      ...new Set(s.days.filter((d) => shownDays.has(d))),
    ].toSorted();
    let why: keyof Dropped | null = null;
    if (QUOTE_MARKS.test(s.text) || s.text === "") {
      why = "quotes";
    } else if (days.length === 0) {
      why = "days";
    } else if (s.text.length > 600) {
      why = "length";
    } else if (
      chars + s.text.length > FULL_TEXT_CHARS ||
      sentences.length >= 60
    ) {
      why = "size";
    }
    if (why) {
      dropped[why] += 1;
    } else {
      sentences.push({ days, text: s.text });
      chars += s.text.length;
    }
  }
  if (sentences.length === 0) {
    throw new Error("no sentence of a month's reply holds a day it was shown");
  }
  return { dropped, headline: r.headline, sentences };
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
 * What the story call is shown: the months through `through`, each as its full text. `through` is the year of the
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
        summary: fullTextOf(m),
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
 * one call, written when its reply holds a sentence with a day it was shown, else its last version stands and the next
 * night reads it again. Then each person's story. A failure costs its month only, never the night.
 */
export async function histories(pending: HistoryWork) {
  const step = await begin("history", "deep", { prompt: MONTH_PROMPT });
  let months = 0;
  let stories = 0;
  let sentences = 0;
  const dropped: Dropped = { days: 0, length: 0, quotes: 0, size: 0 };
  await inBatches(pending.work, step, async (t, dir) => {
    let isRead = true;
    for (const m of t.months) {
      // biome-ignore lint/performance/noAwaitInLoops: one person's file is written one month at a time
      const done = await step.attempt(
        async () => {
          const reply = await step.ask({
            dir: join(dir, m.month),
            input: m.input,
            prompt: MONTH_PROMPT,
          });
          const made = twoSizesOf(reply, new Set(m.shownDays));
          await write(
            t.ref,
            withMonth(readHistory(t.ref), {
              built: step.now.toISOString(),
              headline: made.headline,
              inputs: m.inputs,
              madeBy: stamp(step.llm, MONTH_PROMPT, step.run),
              month: m.month,
              sentences: made.sentences,
            })
          );
          months += 1;
          sentences += made.sentences.length;
          for (const k of Object.keys(dropped) as (keyof Dropped)[]) {
            dropped[k] += made.dropped[k];
          }
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
  return step.end({ dropped, months, sentences, stories });
}
