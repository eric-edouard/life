import { join } from "node:path";
import { clock, daysBefore, iso, MIN, SECOND } from "../core/clock";
import { readJson, writeJson } from "../core/files";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import type { Engine } from "../core/names";
import { listUsdOf, OPENROUTER_DEEPSEEK } from "../core/prices";
import { readBackfillEngine, settings } from "../core/settings";
import {
  conversationSummaries,
  readConversationSummaryWork,
} from "../memory/conversation-summaries";
import { episodesStep } from "../memory/episodes";
import { extract } from "../memory/extract";
import {
  DAYS,
  type Evidence,
  gather,
  hearChatVoiceNotes,
} from "../memory/gather";
import { collectHistorical } from "../memory/historical-collection";
import { prepareHistoricalZones } from "../memory/historical-zones";
import { mattersOver } from "../memory/matters";
import { OUT } from "../memory/memory-files";
import { locked } from "../memory/memory-lock";
import { spareQuota, weeksFrom } from "../memory/schedule";
import { readPeople } from "../memory/who";
import { localDate, type Window } from "../memory/zones";
import type { Held } from "../sources/contract";
import { monthBudgetOf } from "./spending";

// The backfill's estimate: what reading his history from a day would cost, before he picks that day (the setup's
// range). Pure: what each source holds comes in as its `held` (`sources/contract.ts`), the price from `core/prices.ts`.

/**
 * What one message costs to read through every step (its context included): the measured ~$1 per dense month of chats
 * (about 10,000 messages) on OpenRouter. An item of a noun the table doesn't know is estimated as one message.
 */
const MESSAGE_TOKENS = 600;

/**
 * Input tokens one item costs to read through the memory steps, by what the item is (`Held.noun`).
 * ponytail: measured constants, recalibrate from real imports
 */
export const TOKENS_PER_ITEM: Record<string, number> = {
  calls: 200,
  commits: 400,
  conversations: 9000,
  events: 50,
  messages: MESSAGE_TOKENS,
  notes: 3000,
  photos: 500,
  readings: 50,
  tasks: 2000,
};
/** Input tokens the memory steps read in an hour, for the estimate's duration. ponytail: a guess, measure it on a pilot. */
export const TOKENS_PER_HOUR = 2_000_000;

/** A source's name and what its `held` says it holds now. */
export interface HeldSource {
  held: Held | null;
  name: string;
}

export interface BackfillEstimate {
  /** How long reading the range takes. */
  hours: number;
  /** Input tokens the steps read over it. */
  tokens: number;
  /** What a billed engine's credits would pay, on today's price; absent on a subscription. */
  usd?: number;
}

/** The UTC day of an instant: its items are counted by days, so a time of day never skews a share. */
const dayOf = (instant: string) => instant.slice(0, 10);

/**
 * What reading every source from the day `from` on would cost: each source's items in that range, counted by days from
 * the later of `from` and its earliest over its whole span, at `TOKENS_PER_ITEM`; priced only for a billed engine
 * (`openrouter`: `claude` and `codex` run on his subscriptions, so they have no dollars).
 */
export function backfillEstimateOf(
  sources: readonly HeldSource[],
  from: string,
  engine: Engine,
  today = dayOf(iso(clock().getTime()))
): BackfillEstimate {
  const start = Date.parse(from);
  const end = Date.parse(today);
  let tokens = 0;
  for (const { held } of sources) {
    if (!held?.earliest) {
      continue;
    }
    const earliest = Date.parse(dayOf(held.earliest));
    // The range's part of the source: none before its first item, all of it once the range starts before it.
    const inRange = end - Math.max(start, earliest);
    const span = end - earliest;
    if (inRange <= 0 || span <= 0) {
      continue;
    }
    tokens +=
      (held.count * inRange * (TOKENS_PER_ITEM[held.noun] ?? MESSAGE_TOKENS)) /
      span;
  }
  tokens = Math.round(tokens);
  // ponytail: a backfill's tokens are mostly what its steps read (input): the output share is not priced separately.
  const usd =
    engine === "openrouter"
      ? listUsdOf(OPENROUTER_DEEPSEEK, today, {
          cached: 0,
          input: tokens,
          output: 0,
        })
      : undefined;
  return {
    hours: tokens / TOKENS_PER_HOUR,
    tokens,
    ...(usd === undefined ? {} : { usd }),
  };
}

// The backfill: his history read from the day he picked (`settings.backfillFrom`), one week per turn of the nightly's
// tick, the newest month first; then the matters and the conversation summaries, oldest first, which need the weeks
// before them. Progress lives in `LIFE_STATE_DIR/memory/backfill.json`, beside `bridges.json`; the memory lock is taken
// and released week by week, so a night in progress is never held up by more than one week's work.

/** How long one turn keeps taking weeks: the night's tick is every 30 minutes (`schedule.ts`), the rest of it enough. */
const TURN_MS = 20 * MIN;

/** The backfill's progress: what each done week of phase A took, and the week phase B reads next (or `done`). */
export interface BackfillState {
  /** The picked day this progress belongs to; a later pick keeps every week already read. */
  from?: string;
  /** The week of phase B (the matters, then the summaries) to read next, or `done`. */
  phaseB?: string | "done";
  /** Seconds each done week of phase A took, by the week's first day. */
  weeks: Record<string, number>;
}

const STATE = join(OUT, "backfill.json");
/** The progress so far, as the integration line reads it. */
export const readBackfillState = () => readJson<BackfillState>(STATE);

/** What the derivation says of a window (`historical-zones.ts`): the days it defers and the gaps between its runs. */
type ZoneReport = Awaited<ReturnType<typeof prepareHistoricalZones>>;

/**
 * What one turn's weeks do, and whether a week may start: tests pass made-up ones (as `collectHistorical` does with
 * `prepareZones`). Each is one step of the memory, never a second way to run it.
 */
export interface BackfillSteps {
  /** Whether a week may start now: under the quota's reserve and the month's amount (`spareQuota`, `monthBudgetOf`). */
  canStart: (now: Date) => Promise<boolean>;
  /** The week's units, no model (`collectHistorical`), on the zones prepared once for the whole range. */
  collect: (
    window: Window,
    zones?: () => ZoneReport
  ) => Promise<{ failed: number }>;
  episodes: (evidence: Evidence) => Promise<{ failed: number }>;
  /** The week's evidence, gathered once for its episodes and its extract. */
  evidence: (window: Window) => Promise<Evidence>;
  extract: (evidence: Evidence) => Promise<{ failed: number }>;
  /** The chat voice notes of the week heard (`hearChatVoiceNotes`), before its messages are cut into units. */
  hear: (window: Window) => Promise<unknown>;
  /** A week of phase B: its matters placed, the weeks before it read. */
  matters: (
    window: Window,
    engine: Engine | undefined
  ) => Promise<{ failed: number }>;
  /** The conversation summaries from a day on, all of them: the last step of phase B. */
  summaries: (from: string, engine: Engine | undefined) => Promise<unknown>;
  /** The zones of the whole range, derived once before its first week. */
  zones: (window: Window) => Promise<ZoneReport>;
}

const STEPS: BackfillSteps = {
  canStart: async (now) => {
    if (monthBudgetOf(localDate(now.toISOString()))?.isPassed) {
      return false;
    }
    try {
      await spareQuota(readBackfillEngine());
      return true;
    } catch {
      return false;
    }
  },
  collect: (window, zones) =>
    collectHistorical({ from: window.from, to: window.to }, async (w) =>
      zones ? zones() : await prepareHistoricalZones(w)
    ),
  episodes: (evidence) => episodesStep(evidence),
  evidence: async (window) =>
    gather(window, await readPeople(), { engine: readBackfillEngine() }),
  extract: (evidence) => extract(evidence),
  hear: (window) => hearChatVoiceNotes(window),
  matters: (window, engine) => mattersOver([window], { engine, write: true }),
  summaries: async (from, engine) =>
    conversationSummaries(
      await readConversationSummaryWork(clock(), await readPeople(), { from }),
      Number.POSITIVE_INFINITY,
      undefined,
      undefined,
      undefined,
      engine
    ),
  zones: (window) => prepareHistoricalZones(window),
};

/** The weeks of the backfill's range, oldest first: from the picked day to the end of the historical window. */
export function backfillWeeks(from: string, today: string) {
  const end = daysBefore(today, DAYS);
  return from > end ? [] : weeksFrom(from, end);
}

/** What phase A reads first: the newest month's weeks (within a month, any order does, so oldest first). */
function newestMonthFirst(weeks: Window[]) {
  const months = new Map<string, Window[]>();
  for (const week of weeks) {
    const month = week.from.slice(0, 7);
    months.set(month, [...(months.get(month) ?? []), week]);
  }
  return [...months.keys()]
    .sort()
    .reverse()
    .flatMap((month) => months.get(month) ?? []);
}

/**
 * Where the backfill stands: the weeks read and how long they take (their mean), the year it is reading, and the hours
 * left for phase A and phase B. Pure: the progress, the picked day and today.
 */
export function backfillProgressOf(
  state: BackfillState | undefined,
  from: string,
  today: string
) {
  const weeks = backfillWeeks(from, today);
  const done = weeks.flatMap((w) => state?.weeks[w.from] ?? []);
  const mean =
    done.length === 0 ? 0 : done.reduce((a, b) => a + b, 0) / done.length;
  const nextA = newestMonthFirst(weeks).find(
    (w) => state?.weeks[w.from] === undefined
  );
  const phaseB = state?.phaseB;
  const nextB =
    phaseB && phaseB !== "done"
      ? weeks.find((w) => w.from >= phaseB)
      : undefined;
  const leftB =
    phaseB === "done"
      ? 0
      : weeks.filter((w) => !nextB || w.from >= nextB.from).length;
  return {
    doneWeeks: done.length,
    hoursLeft:
      Math.round(((weeks.length - done.length + leftB) * mean) / 360) / 10,
    reading: (nextA ?? nextB ?? weeks.at(-1) ?? { from }).from.slice(0, 4),
    totalWeeks: weeks.length,
  };
}

/** One week of phase A, under the lock: its voice notes heard, its units collected, its episodes and its extract read. */
async function readWeek(
  week: Window,
  zones: ZoneReport | undefined,
  steps: BackfillSteps
) {
  await steps.hear(week);
  const collected = await steps.collect(week, zones ? () => zones : undefined);
  if (collected.failed > 0) {
    throw new Error(`the units of ${week.from} failed`);
  }
  const evidence = await steps.evidence(week);
  if (evidence.failed.length > 0) {
    throw new Error(`${evidence.failed.join(", ")} could not be read`);
  }
  if ((await steps.episodes(evidence)).failed > 0) {
    throw new Error(`the episodes of ${week.from} failed`);
  }
  if ((await steps.extract(evidence)).failed > 0) {
    throw new Error(`the extract of ${week.from} failed`);
  }
}

/**
 * Phase A: the weeks newest month first, each read and written under the lock when its turn comes. Stops at the turn's
 * twenty minutes, the quota's reserve or the month's amount; `false` when memory's lock belongs to another run.
 */
async function backfillRange(
  weeks: Window[],
  state: BackfillState,
  zones: ZoneReport | undefined,
  mayStart: () => Promise<boolean>,
  steps: BackfillSteps
) {
  for (const week of newestMonthFirst(weeks)) {
    if (state.weeks[week.from] !== undefined) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one week at a time, in the order the reading goes
    if (!(await mayStart())) {
      return false;
    }
    const began = clock().getTime();
    const done = await locked(() => readWeek(week, zones, steps));
    if (done === null) {
      return false;
    }
    state.weeks[week.from] = Math.round((clock().getTime() - began) / SECOND);
    writeJson(STATE, state);
  }
  return true;
}

/**
 * Phase B, once every week is read: the matters week by week, oldest first (each sees the ones before), then the
 * conversation summaries over the whole range. Stops like phase A does.
 */
async function backfillLater(
  weeks: Window[],
  state: BackfillState,
  from: string,
  mayStart: () => Promise<boolean>,
  steps: BackfillSteps
) {
  const engine = readBackfillEngine();
  const { phaseB } = state;
  const started =
    phaseB === undefined ? 0 : weeks.findIndex((w) => w.from === phaseB);
  for (
    let i = Math.max(started, 0);
    i < weeks.length && phaseB !== "done";
    i += 1
  ) {
    const week = weeks[i] as Window;
    // biome-ignore lint/performance/noAwaitInLoops: a week's matters see the matters of the weeks before it
    if (!(await mayStart())) {
      return;
    }
    if ((await locked(() => steps.matters(week, engine))) === null) {
      return;
    }
    // The last week's turn is the summaries', which need the whole range read: only then is phase B done.
    const next = weeks[i + 1];
    if (next) {
      state.phaseB = next.from;
      writeJson(STATE, state);
      continue;
    }
    if (!(await mayStart())) {
      return;
    }
    if ((await locked(() => steps.summaries(from, engine))) === null) {
      return;
    }
    state.phaseB = "done";
    writeJson(STATE, state);
  }
}

/**
 * A turn of the backfill, from the nightly's tick: phase A reads his history's weeks (the voice notes heard, the units
 * collected, the episodes and the extract) newest month first; phase B then places the matters week by week and writes
 * the conversation summaries, oldest first. The turn keeps taking weeks until its twenty minutes are spent, the quota's
 * reserve is reached or the month's amount is passed; each week holds the memory lock for itself. A failing week is
 * logged and stops the turn: the next one retries it.
 */
export async function backfill(now: Date, steps: BackfillSteps = STEPS) {
  const from = settings().backfillFrom;
  const today = localDate(now.toISOString());
  const weeks = from ? backfillWeeks(from, today) : [];
  if (!from || weeks.length === 0) {
    return;
  }
  const state = readBackfillState() ?? { weeks: {} };
  state.weeks ??= {};
  // The zones are derived once, over the whole range: a narrower window writes nothing (`historical-zones.ts`).
  const isFirst =
    state.from !== from ||
    weeks.every((w) => state.weeks[w.from] === undefined);
  state.from = from;
  const zones = isFirst
    ? await steps.zones({ from, to: daysBefore(today, DAYS) })
    : undefined;
  writeJson(STATE, state);
  const turnStartedAt = clock().getTime();
  const mayStart = async () =>
    clock().getTime() - turnStartedAt < TURN_MS && (await steps.canStart(now));
  try {
    // Another run holds memory, or the turn is spent: this week and the rest wait for the next tick.
    if (await backfillRange(weeks, state, zones, mayStart, steps)) {
      await backfillLater(weeks, state, from, mayStart, steps);
    }
  } catch (e) {
    log("run.error", { ...errorOf(e), step: "backfill" });
    writeJson(STATE, state);
  }
}
