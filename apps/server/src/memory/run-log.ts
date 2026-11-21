import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { clock, daysBefore, HOUR } from "../core/clock";
import {
  LOG_DIR,
  type LogEvent,
  logDays,
  logEvents,
  logFileOf,
  recentEvents,
} from "../core/log";
import {
  LOG_LEVELS,
  type LogLevel,
  type ShownLine,
  shownLineOf,
} from "../core/log-line";
import type { Quota } from "../models/llm";
import { add, NONE, type ReadCounts, type Tokens } from "../models/model-call";
import { isPromptVersion } from "../models/prompt-parts";
import { decode, encode, PAGE } from "./changes";
import { runAt } from "./memory-files";
import { lockedSince } from "./memory-lock";
import { spendsOfLine } from "./spends";
import { dayNow, lastDays, localDate, localTime } from "./zones";

// Life's processing as recorded, as JSON for the status reads: `read_processing_runs` (the history in derived/log: processing runs, their steps,
// outcomes, counts, errors); `lifeStatus` (host/status/life.ts) reads it. Read-only, like changes.ts.

/** The model calls of these prompts (any variant) made on his day today, failures included: a daytime step's cap. */
export async function readCallsToday(prompts: string[]) {
  const day = dayNow();
  return (
    await recentEvents<{ at: string; prompt?: string }>(2, "model.run")
  ).filter(
    (e) =>
      e.prompt !== undefined &&
      prompts.some((p) => isPromptVersion(e.prompt as string, p)) &&
      localDate(e.at) === day
  ).length;
}

// --- runs ----------------------------------------------------------------------------------------------------------

/** The processing runs: one launchd start that runs several steps (`memory.backfill`: past runs still in the log). */
export const PROCESSING_RUNS = new Set(["memory.nightly", "memory.backfill"]);
/** The steps a processing run runs, in their order (the night alone maps repos and judges closeness). */
export const STEPS = [
  "memory.repos",
  "memory.files",
  "memory.episodes",
  "memory.extract",
  "memory.closeness",
  "memory.pages",
];
/** The pipeline's runs; others (the watcher's hearings until 19 Oct: memory.intent, memory.intent-screen) only when asked for. */
const PIPELINE = [
  ...PROCESSING_RUNS,
  ...STEPS,
  // Until 18 Oct the verdicts had a step of their own, and inferring people another; 6–8 Nov 2026, tagging details.
  "memory.triage",
  "memory.infer",
  "memory.details",
];

const omit = (e: LogEvent | undefined) => {
  if (!e) {
    return null;
  }
  const {
    at: _a,
    category: _c,
    error,
    errorType,
    kind: _k,
    level: _l,
    msg: _m,
    run: _r,
    step: _s,
    time: _t,
    ...rest
  } = e;
  // An error leaves the Mac by its type only (a line before 21 Nov 2026 has none: `failed`); its words stay in the log.
  return error || errorType
    ? { ...rest, errorType: errorType ?? "failed" }
    : rest;
};

/**
 * What model calls spent and read, summed over their spends (`modelCallsOf`): how many, tokens, dollars billed and the
 * list-price equivalent of his plans' tokens (two bases, never added), the spends not reported, units read by source.
 */
export interface Calls {
  billedUsd: number;
  calls: number;
  equivalentUsd: number;
  notReported: number;
  reads: ReadCounts;
  tokens: Tokens;
}
const NO_CALLS: Calls = {
  billedUsd: 0,
  calls: 0,
  equivalentUsd: 0,
  notReported: 0,
  reads: {},
  tokens: NONE,
};
const addReads = (a: ReadCounts, b: ReadCounts): ReadCounts => {
  const sum = { ...a };
  for (const [k, n] of Object.entries(b) as [keyof ReadCounts, number][]) {
    sum[k] = (sum[k] ?? 0) + n;
  }
  return sum;
};
const addCalls = (a: Calls, b: Calls): Calls => ({
  billedUsd: a.billedUsd + b.billedUsd,
  calls: a.calls + b.calls,
  equivalentUsd: a.equivalentUsd + b.equivalentUsd,
  notReported: a.notReported + b.notReported,
  reads: addReads(a.reads, b.reads),
  tokens: add(a.tokens, b.tokens),
});

/** What a run spent: its calls' sum, and for a metered run on an engine with a quota the quota read around it (`useOf`). */
export interface Use extends Calls {
  quota: { after: Quota | null; before: Quota | null } | null;
}

export interface Run {
  /** Steps that ran inside a processing run, by id. */
  children?: string[];
  endedAt: string | null;
  errors: Record<string, unknown>[];
  id: string;
  input: Record<string, unknown> | null;
  /** ok | failed | running (it holds the lock now) | unfinished (no end recorded: interrupted, or still running unlocked). */
  outcome: "failed" | "ok" | "running" | "unfinished";
  /** The processing run it ran in, if any. */
  processingRun?: string;
  /** A processing run's steps in the order it entered them (`trackProcessingSteps`, run.ts), its steps among them. */
  processingSteps?: string[];
  result: Record<string, unknown> | null;
  startedAt: string | null;
  step: string;
  /** What it spent; null when it made no model call and read no quota. */
  use?: Use | null;
  /** The local days its sources were read for. */
  window?: { from: string; to: string };
}

/** The percent a run took: null when either reading is missing or the window reset during it. */
export const percentOf = (u: Use) =>
  u.quota?.after &&
  u.quota.before &&
  u.quota.after.resetsAt === u.quota.before.resetsAt
    ? u.quota.after.used - u.quota.before.used
    : null;

/** Tokens as a person reads them: 812k, 2.1M. */
const tokensText = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`;

/**
 * A run's use in words: "+1% of the quota, 2.1M tokens (1.4M cached), $0.12 billed, ≈ $3.40 at list price, not billed,
 * 3 not reported", the two bases apart; under 1% when the whole percent didn't move; its tokens alone when it read no
 * quota (a step, or an engine without one).
 */
export function useText(u: Use | null) {
  const t = u?.tokens ?? NONE;
  const tokens = [
    `${tokensText(t.input + t.output)} tokens (${tokensText(t.cached)} cached)`,
    ...(u?.billedUsd ? [`$${u.billedUsd.toFixed(2)} billed`] : []),
    ...(u?.equivalentUsd
      ? [`≈ $${u.equivalentUsd.toFixed(2)} at list price, not billed`]
      : []),
    ...(u?.notReported ? [`${u.notReported} not reported`] : []),
  ].join(", ");
  if (!u?.quota) {
    return tokens;
  }
  const p = percentOf(u);
  if (p !== null) {
    return `${p < 1 ? "under 1%" : `+${p}%`} of the quota, ${tokens}`;
  }
  const read = u?.quota?.before && u.quota.after;
  return `${read ? "the quota reset during it" : "quota not read"}, ${tokens}`;
}

/**
 * What the runs started since `since` spent, oldest first, in words: a line per run, a processing run's steps each under it
 * (every row, no cap). `night` is the run whose quota ends at the reading just made for the email.
 */
export function spendLines(
  recent: Run[],
  since: string,
  night: { id: string; quota: Quota | undefined }
) {
  const used = recent
    .filter((r) => (r.startedAt ?? "") >= since && r.use)
    .toSorted((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const name = (r: Run) => r.step.replace("memory.", "");
  return used
    .filter((r) => !r.processingRun)
    .flatMap((r) => [
      r.id === night.id && r.use
        ? `Model use, this night: ${useText({ ...r.use, quota: r.use.quota && { after: night.quota ?? null, before: r.use.quota.before } })}`
        : `Model use, ${name(r)} of ${localTime(r.startedAt ?? "")}: ${useText(r.use ?? null)}`,
      ...used
        .filter((c) => c.processingRun === r.id)
        .map((c) => `  ${name(c)}: ${useText(c.use ?? null)}`),
    ]);
}

/**
 * A run's use, derived from the log: its model calls (`model.run` lines with its run id) and its steps', and for a
 * metered run (`metered`, run.ts) the quota it logged as it started and ended (null while it runs).
 */
function useOf(
  r: Run,
  callsBy: Map<string, Calls>,
  byId: Map<string, Run>
): Use | null {
  const own = (x: Run) => callsBy.get(x.id.slice(x.step.length + 1));
  const parts = [
    r,
    ...(r.children ?? []).flatMap((c) => byId.get(c) ?? []),
  ].flatMap((x) => own(x) ?? []);
  const quota =
    r.input && "quota" in r.input
      ? {
          after: (r.result?.quota as Quota | undefined) ?? null,
          before: r.input.quota as Quota | null,
        }
      : null;
  if (!(parts.length || quota)) {
    return null;
  }
  return { ...parts.reduce(addCalls, NO_CALLS), quota };
}

/** A processing run's sub-step (memory.nightly.actions) belongs to its processing run. */
const stepOf = (s: string) =>
  [...PROCESSING_RUNS].find((w) => s.startsWith(`${w}.`)) ?? s;

/** An error as a run lists it, naming the sub-step it came from. */
const errorOf = (e: LogEvent) => ({
  at: e.at,
  ...omit(e),
  ...(e.step === stepOf(e.step) ? {} : { step: e.step }),
});

/** Folds one event of a run into it; a sub-step's start or end is not its processing run's. */
function apply(r: Run, e: LogEvent) {
  if (e.kind === "run.error") {
    r.errors.push(errorOf(e));
  } else if (e.step === r.step && e.kind === "run.entered") {
    r.processingSteps = [...(r.processingSteps ?? []), String(e.entered)];
  } else if (e.step === r.step && e.kind === "run.end") {
    r.result = omit(e);
    r.endedAt = e.at;
  } else if (e.step === r.step && e.kind === "run.start") {
    r.input = omit(e);
    const days = Number(e.days);
    const start = new Date(r.startedAt ?? e.at);
    if (typeof e.from === "string" && typeof e.to === "string") {
      r.window = { from: e.from, to: e.to };
    } else if (days > 0) {
      r.window = {
        from: lastDays(start, days).from,
        to: localDate(start.toISOString()),
      };
    }
  }
}

function outcomeOf(r: Run, lockSince: Date | null): Run["outcome"] {
  if (r.result) {
    const failed =
      r.result.outcome === "failed" || Number(r.result.failed ?? 0) > 0;
    return failed ? "failed" : "ok";
  }
  const running = lockSince && (r.startedAt ?? "") >= lockSince.toISOString();
  return running ? "running" : "unfinished";
}

const blank = (id: string, step: string, startedAt: string | null): Run => ({
  endedAt: null,
  errors: [],
  id,
  input: null,
  outcome: "unfinished",
  result: null,
  startedAt,
  step,
});

/** Puts each step in the processing run it ran in, and each run-less error (older logs) in its processing run, or on its own. */
function nest(list: Run[], orphans: LogEvent[]) {
  // Processing runs hold the lock, so they never overlap: one with no end (interrupted) ends where the next one starts.
  const processingRuns = list
    .filter((r) => PROCESSING_RUNS.has(r.step))
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const until = (s: Run) =>
    s.endedAt ??
    processingRuns[processingRuns.indexOf(s) + 1]?.startedAt ??
    "9999";
  const inProcessingRun = (at: string, s: Run) =>
    at >= (s.startedAt ?? "") && at <= until(s);
  for (const s of processingRuns) {
    const mine = list.filter(
      (r) =>
        !PROCESSING_RUNS.has(r.step) && inProcessingRun(r.startedAt ?? "", s)
    );
    for (const r of mine) {
      r.processingRun = s.id;
    }
    s.children = mine.map((r) => r.id);
  }
  for (const e of orphans) {
    const step = stepOf(e.step);
    const s = processingRuns.find(
      (w) => w.step === step && inProcessingRun(e.at, w)
    );
    if (s) {
      s.errors.push(errorOf(e));
    } else {
      list.push({
        ...blank(`${step}/error@${e.at}`, step, null),
        endedAt: e.at,
        errors: [errorOf(e)],
        outcome: "failed",
      });
    }
  }
  return list;
}

/**
 * Every run the events record, each step nested in the processing run it ran in, whatever a reader then shows: a step
 * left out here would drop its spend from its night. `lockSince` tells a run in progress from an interrupted one.
 */
export function assembleRuns(events: LogEvent[], lockSince: Date | null) {
  const byId = new Map<string, Run>();
  const orphans: LogEvent[] = [];
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!e.kind.startsWith("run.")) {
      continue;
    }
    const step = stepOf(e.step);
    if (!e.run) {
      if (e.kind === "run.error") {
        orphans.push(e);
      }
      continue;
    }
    const id = `${step}/${e.run}`;
    const r = byId.get(id) ?? blank(id, step, runAt(e.run));
    apply(r, e);
    byId.set(id, r);
  }
  const list = [...byId.values()];
  for (const r of list) {
    r.outcome = outcomeOf(r, lockSince);
  }
  nest(list, orphans);
  const callsBy = modelCallsOf(events);
  for (const r of list) {
    if (r.startedAt) {
      r.use = useOf(r, callsBy, byId);
    }
  }
  return list;
}

/**
 * The model calls (`model.run` lines, read as spends: `spendsOfLine`) summed by run id, or by `groupOf` (the source-use
 * table's run and day): the one fold of what calls spent and read. A call with a spend whose amount is unknown is not reported, once.
 */
export function modelCallsOf(
  events: LogEvent[],
  groupOf = (e: LogEvent) => e.run
) {
  const by = new Map<string, Calls>();
  for (const e of events) {
    const key = e.kind === "model.run" && e.run && groupOf(e);
    const spends = key ? spendsOfLine(e, "daytime") : [];
    // A call is not reported once, whichever of its routers' tries sent no cost.
    const isNotReported = spends.some((s) => !s.reported);
    for (const s of spends) {
      by.set(
        key as string,
        addCalls(by.get(key as string) ?? NO_CALLS, {
          billedUsd: s.basis === "billed" ? (s.usd ?? 0) : 0,
          calls: s.calls,
          equivalentUsd: s.equivalentUsd ?? 0,
          notReported: isNotReported && s.calls > 0 ? 1 : 0,
          reads: s.reads ?? {},
          tokens: s.tokens ?? NONE,
        })
      );
    }
  }
  return by;
}

/** One day's events a run is made of: its run lines and the model calls it made. */
export const runEvents = (name: string, dir = LOG_DIR) => [
  ...logEvents<LogEvent>(name, "run.", dir),
  ...logEvents<LogEvent>(name, "model.run", dir),
];

/** Newest first; a run without a start (an old error) sorts by its end. */
const keyOf = (r: Run) => r.startedAt ?? r.endedAt ?? "";
const newestFirst = (a: Run, b: Run) =>
  keyOf(b).localeCompare(keyOf(a)) || b.id.localeCompare(a.id);

/** The runs of the last `days` days of derived/log, newest first (`read_life_status`). */
export async function latestRuns(days: number, lock: Date | null) {
  const events = (await logDays()).slice(0, days).flatMap((n) => runEvents(n));
  const shown = new Set(PIPELINE);
  return assembleRuns(events, lock)
    .filter((r) => shown.has(r.step))
    .sort(newestFirst);
}

export interface RunsQuery {
  cursor?: string;
  /** Every step, whatever `steps` says (the email, the snapshot). */
  everyStep?: true;
  limit?: number;
  /** Steps to list (memory.episodes, memory.intent…); default: the processing runs and the pipeline's steps. */
  steps?: string[];
}

/**
 * Processing history, newest first, from derived/log. Reads the log back a day at a time, only as far as the page
 * needs; a page holds only runs whose start lies within the days read (a run's end is always in a later or the same
 * file), so nothing older can sort before them. The cursor is the last run's key: new runs never shift older pages.
 */
export async function runs(q: RunsQuery = {}, dir = LOG_DIR) {
  const limit = q.limit ?? PAGE;
  const steps = new Set(q.steps?.length ? q.steps : PIPELINE);
  const isShown = (r: Run) => q.everyStep || steps.has(r.step);
  const after = decode(q.cursor, z.tuple([z.string(), z.string()]), null);
  const days = await logDays(dir);
  const lock = lockedSince();
  const events: LogEvent[] = [];
  let read = 0;
  let next = 1;
  let page: Run[] = [];
  let more = false;
  const older = (r: Run) =>
    !after || keyOf(r) < after[0] || (keyOf(r) === after[0] && r.id < after[1]);
  for (const [i, name] of days.entries()) {
    const day = name.slice(0, 10);
    // Runs older than the cursor started on its day or before; their ends can be a day later.
    if (after && day > nextDay(after[0])) {
      continue;
    }
    events.push(...runEvents(name, dir));
    read += 1;
    const last = i === days.length - 1;
    // ponytail: assembled after 1, 2, 4, 8… days read, so a rare step's page costs about twice one assembly of
    // every day; a page may read up to twice the days it needs.
    if (!last && read < next) {
      continue;
    }
    next *= 2;
    const ready = assembleRuns(events, lock)
      .filter((r) => isShown(r) && (last || keyOf(r) >= `${day}T`) && older(r))
      .sort(newestFirst);
    if (ready.length > limit || last) {
      page = ready.slice(0, limit);
      more = ready.length > limit;
      break;
    }
  }
  const end = page.at(-1);
  return {
    count: page.length,
    cursor: more && end ? encode([keyOf(end), end.id]) : null,
    items: page,
    observedAt: clock().toISOString(),
  };
}

const nextDay = (iso: string) => daysBefore(iso.slice(0, 10), -1);

// --- log lines -----------------------------------------------------------------------------------------------------

/** The day files one `read_log_lines` call reads at most: the rest is the next page's. */
const LOG_DAYS_PER_READ = 2;
/** A place in the log: a day's file and a byte in it (null: the file's end). A page's cursor, a line's id, a head. */
const LogCursor = z.tuple([z.string(), z.int().nonnegative().nullable()]);

export interface LogLinesQuery {
  /** A `head` from an earlier page: only the lines written after it. */
  after?: string;
  cursor?: string;
  limit?: number;
  minLevel?: LogLevel;
  process?: string;
}

/** One stored line as `q` shows it, or undefined: filtered out, or not a line (a bad line never stops a reader). */
function shownOf(raw: string, q: LogLinesQuery) {
  let shown: ShownLine | undefined;
  try {
    shown = shownLineOf(JSON.parse(raw));
  } catch {
    return;
  }
  const isShown =
    shown &&
    !isOwnRead(shown) &&
    LOG_LEVELS.indexOf(shown.level) >=
      LOG_LEVELS.indexOf(q.minLevel ?? "info") &&
    (!q.process || shown.category[0] === q.process);
  return isShown ? shown : undefined;
}

/** A read of the log that went through: left out, or his app's live log would show its own polling. */
const isOwnRead = (l: ShownLine) =>
  l.level === "info" &&
  l.category[0] === "mcp" &&
  l.category[1] === "read_log_lines";

/**
 * The event log's lines as his app is shown them (`shownLineOf`), each with its `id` (its place in the log: passed as
 * a cursor, it reads the lines before it), newest first, never the log's own reads, at least `minLevel` and of `process`
 * (a category's first word) when given, and only those written after `after` when given. Reads at most
 * `LOG_DAYS_PER_READ` day files per page: a page may be short, and its `cursor` (a place in the log, so lines appended
 * meanwhile never shift it) goes on; null when no older line is left. A read from the top also gives `head`, the log's
 * end as read: passed back as `after`, a poll reads only what came since, whatever the filter matched.
 */
export async function readLogLines(q: LogLinesQuery = {}, dir = LOG_DIR) {
  const limit = q.limit ?? PAGE;
  const from = decode(q.cursor, LogCursor, null);
  const after = decode(q.after, LogCursor, null);
  const days = (await logDays(dir)).filter(
    (n) => (!from || n <= from[0]) && (!after || n >= after[0])
  );
  const [top] = days;
  const head: z.infer<typeof LogCursor> | null =
    from || !top ? null : [top, newestEnd(join(dir, top))];
  const start = from ?? head;
  const lines: (ShownLine & { id: string })[] = [];
  for (const name of days.slice(0, LOG_DAYS_PER_READ)) {
    const stop = name === start?.[0] ? start[1] : null;
    for (const { end, raw } of linesFromEnd(join(dir, name), stop)) {
      // Its place in the log: the cursor of the lines before it, so unique.
      const at = end - Buffer.byteLength(raw) - 1;
      if (isBefore(after, name, at)) {
        return logPage(lines, null, head);
      }
      if (lines.length === limit) {
        return logPage(lines, [name, end], head);
      }
      const shown = shownOf(raw, q);
      if (shown) {
        lines.push({ id: encode([name, at]), ...shown });
      }
    }
  }
  const older = days[LOG_DAYS_PER_READ];
  return logPage(lines, older ? [older, null] : null, head);
}

/** Whether a line starting at byte `at` of day file `name` is before `place` (only its own day's lines can be). */
const isBefore = (
  place: z.infer<typeof LogCursor> | null,
  name: string,
  at: number
) => place !== null && name === place[0] && at < (place[1] ?? 0);

/** The byte after a day file's newest whole line: where its next line starts (a torn one is not read yet). */
function newestEnd(path: string) {
  for (const { end } of linesFromEnd(path)) {
    return end;
  }
  return 0;
}

const logPage = (
  lines: (ShownLine & { id: string })[],
  next: z.infer<typeof LogCursor> | null,
  head: z.infer<typeof LogCursor> | null
) => ({
  cursor: next && encode(next),
  head: head && encode(head),
  lines,
  observedAt: clock().toISOString(),
});

const BLOCK = 64 * 1024;
const NEWLINE = 10;

/**
 * A file's lines from its end, newest first, read back a block at a time, each with the byte after its newline
 * (`end`, a page's cursor); only those ending by `stop` when given. A torn last line (no newline yet) is left out.
 */
function* linesFromEnd(path: string, stop: number | null = null) {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    const { size } = fstatSync(fd);
    let pos = Math.min(size, stop ?? size);
    let rest = Buffer.alloc(0);
    // Until a newline is seen, the end is a torn line still being written: skipped, as `linesOf` does.
    let isTorn = true;
    const block = Buffer.alloc(BLOCK);
    while (pos > 0) {
      const n = Math.min(BLOCK, pos);
      pos -= n;
      readSync(fd, block, 0, n, pos);
      // A newline byte is never inside a UTF-8 character, so a cut between blocks never splits one wrongly.
      const buf = Buffer.concat([block.subarray(0, n), rest]);
      let end: number = isTorn ? buf.lastIndexOf(NEWLINE) : buf.length;
      isTorn = end < 0;
      let i = end > 0 ? buf.lastIndexOf(NEWLINE, end - 1) : -1;
      while (i >= 0) {
        if (end > i + 1) {
          yield { end: pos + end + 1, raw: buf.toString("utf8", i + 1, end) };
        }
        end = i;
        i = end > 0 ? buf.lastIndexOf(NEWLINE, end - 1) : -1;
      }
      rest = buf.subarray(0, Math.max(end, 0));
    }
    if (rest.length > 0) {
      yield { end: rest.length + 1, raw: rest.toString("utf8") };
    }
  } finally {
    closeSync(fd);
  }
}

const LINE_TIME = /"(?:time|at)":"([^"]+)"/;
const SAMPLE = '"kind":"resource.sample"';

/**
 * The resource samples of the last hour (`sampleResources`), oldest first, and the latest: read back from the end of
 * today's log file (and yesterday's, across midnight) until a line older than the hour, never a whole day.
 */
export function readResourceSamples(now = clock(), dir = LOG_DIR) {
  const since = new Date(now.getTime() - HOUR).toISOString();
  const observedAt = now.toISOString();
  const files = [now, new Date(now.getTime() - HOUR)]
    .map((d) => logFileOf(d.toISOString()))
    .filter((f, i, all) => all.indexOf(f) === i);
  const back: Record<string, unknown>[] = [];
  for (const file of files) {
    for (const { raw: line } of linesFromEnd(join(dir, file))) {
      const at = line.match(LINE_TIME)?.[1];
      if (at !== undefined && at < since) {
        break;
      }
      if (line.includes(SAMPLE) && at !== undefined && at <= observedAt) {
        try {
          const {
            category: _c,
            kind: _k,
            level: _l,
            msg: _m,
            ...sample
          } = JSON.parse(line);
          back.push(sample);
        } catch {
          // A torn last line: the next read has it whole.
        }
      }
    }
  }
  const hour = back.reverse();
  return { hour, latest: hour.at(-1) ?? null, observedAt };
}
