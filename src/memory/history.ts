import { statSync } from "node:fs";
import { z } from "zod";
import { lastCopied } from "../archive";
import { clock } from "../clock";
import { polling, readHealth } from "../health";
import { add, NONE, type Quota, type Tokens } from "../llm";
import {
  LOG_DIR,
  type LogEvent,
  logDays,
  logEvents,
  recentEvents,
} from "../log";
import { keptStores, listening } from "../sources/index";
import { decode, encode, PAGE } from "./feed";
import {
  lockedSince,
  MAX_ATTEMPTS,
  nextMidday,
  nextNight,
  readBackfill,
  readMidday,
  readState,
} from "./guard";
import { runAt } from "./ledger";
import { INDEX } from "./search";
import { daysBefore, lastDays } from "./units";
import { localDate } from "./zones";

// Life's processing as recorded, as JSON for a dashboard: `runs` (the history in derived/log: sweeps, their steps,
// outcomes, counts, errors) and `lifeStatus` (is Life working, how fresh, what runs next). Read-only, like feed.ts.

// --- runs ----------------------------------------------------------------------------------------------------------

/** The sweeps: one launchd start that runs several steps. */
const SWEEPS = new Set(["memory.nightly", "memory.midday", "memory.backfill"]);
/** The steps a sweep runs, in their order (the night alone maps repos and judges closeness). */
export const STEPS = [
  "memory.repos",
  "memory.files",
  "memory.moments",
  "memory.extract",
  "memory.closeness",
  "memory.pages",
];
/** The pipeline's runs; others (the watcher's hearings until 19 Oct: memory.intent, memory.intent-screen) only when asked for. */
const PIPELINE = [
  ...SWEEPS,
  ...STEPS,
  // Until 18 Oct the verdicts had a step of their own, and inferring people another.
  "memory.triage",
  "memory.infer",
];

const omit = (e: LogEvent | undefined) => {
  if (!e) {
    return null;
  }
  const { at: _a, kind: _k, run: _r, step: _s, ...rest } = e;
  return rest;
};

/** What a run spent of his Codex plan: its tokens, and for a metered run the quota read around it (`useOf`). */
export interface Use {
  quota: { after: Quota | null; before: Quota | null } | null;
  tokens: Tokens;
}

export interface Run {
  /** Steps that ran inside a sweep, by id. */
  children?: string[];
  endedAt: string | null;
  errors: Record<string, unknown>[];
  id: string;
  input: Record<string, unknown> | null;
  /** ok | failed | running (it holds the lock now) | unfinished (no end recorded: interrupted, or still running unlocked). */
  outcome: "failed" | "ok" | "running" | "unfinished";
  /** A sweep's phases in the order it entered them (`phases`, run.ts), its steps among them. */
  phases?: string[];
  result: Record<string, unknown> | null;
  startedAt: string | null;
  step: string;
  /** The sweep it ran in, if any. */
  sweep?: string;
  /** What it spent of his Codex plan; null when it made no model call and reads no quota. */
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

/** A run's use in words: "+1% of the quota, 2.1M tokens (1.4M cached)"; under 1% when the whole percent didn't move. */
export function useText(u: Use | null) {
  const t = u?.tokens ?? NONE;
  const tokens = `${tokensText(t.input + t.output)} tokens (${tokensText(t.cached)} cached)`;
  const p = u ? percentOf(u) : null;
  if (p !== null) {
    return `${p < 1 ? "under 1%" : `+${p}%`} of the quota, ${tokens}`;
  }
  const read = u?.quota?.before && u.quota.after;
  return `${read ? "the quota reset during it" : "quota not read"}, ${tokens}`;
}

/**
 * A run's use, derived from the log: the tokens of its model calls (`model.run` lines with its run id) and its steps',
 * and for a metered run (`metered`, run.ts) the quota it logged as it started and ended (null while it runs).
 */
function useOf(
  r: Run,
  tokensBy: Map<string, Tokens>,
  byId: Map<string, Run>
): Use | null {
  const own = (x: Run) => tokensBy.get(x.id.slice(x.step.length + 1));
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
  return { quota, tokens: parts.reduce(add, NONE) };
}

/** A sweep's sub-step (memory.nightly.actions) belongs to its sweep. */
const stepOf = (s: string) =>
  [...SWEEPS].find((w) => s.startsWith(`${w}.`)) ?? s;

/** An error as a run lists it, naming the sub-step it came from. */
const errorOf = (e: LogEvent) => ({
  at: e.at,
  ...omit(e),
  ...(e.step === stepOf(e.step) ? {} : { step: e.step }),
});

/** Folds one event of a run into it; a sub-step's start or end is not its sweep's. */
function apply(r: Run, e: LogEvent) {
  if (e.kind === "run.error") {
    r.errors.push(errorOf(e));
  } else if (e.step === r.step && e.kind === "run.phase") {
    r.phases = [...(r.phases ?? []), String(e.phase)];
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

/** Puts each step in the sweep it ran in, and each run-less error (older logs) in its sweep, or on its own. */
function nest(list: Run[], orphans: LogEvent[]) {
  // Sweeps hold the lock, so they never overlap: one with no end (interrupted) ends where the next one starts.
  const sweeps = list
    .filter((r) => SWEEPS.has(r.step))
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const until = (s: Run) =>
    s.endedAt ?? sweeps[sweeps.indexOf(s) + 1]?.startedAt ?? "9999";
  const inSweep = (at: string, s: Run) =>
    at >= (s.startedAt ?? "") && at <= until(s);
  for (const s of sweeps) {
    const mine = list.filter(
      (r) => !SWEEPS.has(r.step) && inSweep(r.startedAt ?? "", s)
    );
    for (const r of mine) {
      r.sweep = s.id;
    }
    s.children = mine.map((r) => r.id);
  }
  for (const e of orphans) {
    const step = stepOf(e.step);
    const s = sweeps.find((w) => w.step === step && inSweep(e.at, w));
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

/** The runs the events record, for the given steps; `lockSince` tells a run in progress from an interrupted one. */
export function assembleRuns(
  events: LogEvent[],
  steps: Set<string>,
  lockSince: Date | null
) {
  const byId = new Map<string, Run>();
  const orphans: LogEvent[] = [];
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!e.kind.startsWith("run.")) {
      continue;
    }
    const step = stepOf(e.step);
    if (!steps.has(step)) {
      continue;
    }
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
  const tokensBy = tokensOf(events);
  for (const r of list) {
    if (r.startedAt) {
      r.use = useOf(r, tokensBy, byId);
    }
  }
  return list;
}

/** The tokens of the model calls, by run id. */
function tokensOf(events: LogEvent[]) {
  const by = new Map<string, Tokens>();
  for (const e of events) {
    const t = e.tokens as Tokens | undefined;
    if (e.kind === "model.run" && e.run && t) {
      by.set(e.run, add(by.get(e.run) ?? NONE, t));
    }
  }
  return by;
}

/** One day's events a run is made of: its run lines and the model calls it made. */
const runEvents = (name: string, dir = LOG_DIR) => [
  ...logEvents<LogEvent>(name, "run.", dir),
  ...logEvents<LogEvent>(name, "model.run", dir),
];

/** Newest first; a run without a start (an old error) sorts by its end. */
const keyOf = (r: Run) => r.startedAt ?? r.endedAt ?? "";
const newestFirst = (a: Run, b: Run) =>
  keyOf(b).localeCompare(keyOf(a)) || b.id.localeCompare(a.id);

export interface RunsQuery {
  cursor?: string;
  limit?: number;
  /** Steps to list (memory.moments, memory.intent…); default: the sweeps and the pipeline's steps. */
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
  const after = decode(q.cursor, z.tuple([z.string(), z.string()]), null);
  const days = await logDays(dir);
  const lock = lockedSince();
  const events: LogEvent[] = [];
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
    const last = i === days.length - 1;
    // Assembled with the whole pipeline, so a sweep lists its steps whatever `steps` shows.
    const ready = assembleRuns(events, new Set([...PIPELINE, ...steps]), lock)
      .filter(
        (r) => steps.has(r.step) && (last || keyOf(r) >= `${day}T`) && older(r)
      )
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

// --- status --------------------------------------------------------------------------------------------------------

/** Each archive store's last copy (`lastCopied`), by store name. */
const copiedByStore = (): Record<string, string | null> =>
  Object.fromEntries(keptStores().map((s) => [s.name, lastCopied(s)]));

/** When a SQLite file last changed, its write-ahead log included (written before the file); null: no file. */
function dbTime(path: string) {
  const ms = Math.max(
    ...[path, `${path}-wal`].map(
      (p) => statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0
    )
  );
  return ms ? new Date(ms).toISOString() : null;
}

/** How far back `status` looks in derived/log for the last runs of each kind. */
const STATUS_DAYS = 7;

/** The latest run of a step, and the latest that succeeded and failed, within what `status` read. */
function lastOf(list: Run[], step: string) {
  const mine = list.filter((r) => r.step === step);
  return {
    lastFailed: mine.find((r) => r.outcome === "failed") ?? null,
    lastOk: mine.find((r) => r.outcome === "ok") ?? null,
    latest: mine[0] ?? null,
  };
}

/**
 * Is Life working, how fresh is its memory, and what runs next. Four clocks, kept apart: capture (the watcher folds
 * lifelog in as it arrives; the archive copies chats), extraction (midday, nightly, backfill weeks), consolidation
 * (pages: midday and nightly) and the index (rebuilt by the watcher on any lifelog change and by every sweep: a new index is not new memory).
 * A missing record is "unknown", never healthy.
 */
export async function lifeStatus(now = clock()) {
  const health = readHealth();
  const lock = lockedSince();
  const night = readState();
  const middaySlot = readMidday();
  const events = (await logDays())
    .slice(0, STATUS_DAYS)
    .flatMap((n) => runEvents(n));
  // The tick reads the quota every 30 minutes: its last reading (an unread one has no figures) says whether middays wait.
  const quota = (await recentEvents<Partial<Quota>>(2, "quota.read")).at(-1);
  const list = assembleRuns(events, new Set(PIPELINE), lock).sort(newestFirst);
  const running = list.filter((r) => r.outcome === "running");
  let watcher: Record<string, unknown> = { state: "unknown" };
  if (!listening()) {
    watcher = { state: "off" };
  } else if (health) {
    watcher = {
      ...health,
      state: polling(health, now.getTime()) ? "ok" : "not-polling",
    };
  }
  return {
    backfill: {
      ...lastOf(list, "memory.backfill"),
      state: readBackfill() ?? null,
    },
    capture: {
      archive: copiedByStore(),
      // The key keeps its name for the dashboard's contract: the verdicts are the moments step's since 18 Oct.
      lastTriage: lastOf(list, "memory.moments").latest?.result ?? null,
      lifelogOkAt: health?.lastOkAt ?? null,
    },
    consolidation: lastOf(list, "memory.pages"),
    extraction: lastOf(list, "memory.extract"),
    indexBuiltAt: dbTime(INDEX),
    lookbackDays: STATUS_DAYS,
    midday: {
      ...lastOf(list, "memory.midday"),
      next: nextMidday(now, middaySlot, quota),
      slotSpentAt: middaySlot ?? null,
    },
    nightly: {
      ...lastOf(list, "memory.nightly"),
      maxAttempts: MAX_ATTEMPTS,
      next: nextNight(now, localDate(now.toISOString()), night),
      state: night ?? "unknown",
    },
    observedAt: now.toISOString(),
    processing: lock
      ? {
          // The phase the sweep last entered (`phases`, run.ts), else the step running (runs from before 21 Oct).
          phase:
            running.find((r) => SWEEPS.has(r.step))?.phases?.at(-1) ??
            running.find((r) => !SWEEPS.has(r.step))?.step ??
            null,
          since: lock.toISOString(),
          state: "running",
          sweep: running.find((r) => SWEEPS.has(r.step))?.id ?? null,
        }
      : { state: "idle" },
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    watcher,
  };
}
