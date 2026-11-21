import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { filesIn, linesOf } from "./files";
import { logWriter } from "./log-line";
import { LIFE_STATE_DIR } from "./paths";
import { agentNames } from "./settings";

// One structured event log for everything Life does, so any failure can be traced for a year (the nightly drops older days):
// derived/log/YYYY-MM-DD.jsonl, one JSON object per line, written through LogTape (`@logtape/logtape`): `time`, `level`,
// `category` (`["life", process, step…]`), `msg` (LogTape's raw template, its placeholders the line's own fields) and the
// fields. Metadata only: counts, ids, kinds, durations, statuses, an error as `errorOf` keeps it. Never message text,
// quotes, a call's argument values, a body sent or an answer (those live in the sources and memory/); fields named for
// content are dropped before the line is written (`CONTENT`, LogTape's redaction) as a net under every writer.

export const LOG_DIR = join(LIFE_STATE_DIR, "log");

type LogKind =
  | "calendar.write"
  | "card.push_accepted"
  | "decision.answered"
  | "decision.asked"
  | "decision.withdrawn"
  | "desk.change"
  | "desk.complaints"
  | "desk.fold"
  | "desk.hand_out"
  | "desk.move"
  | "desk.net"
  | "desk.queued"
  | "desk.runtime"
  | "desk.store_step"
  | "desk.turn"
  | "draft.send"
  | "email.sent"
  | "file.read"
  | "lifelog.write"
  | "matter.icons"
  | "mcp.call"
  | "model.local"
  | "model.retry"
  | "model.run"
  | "offline"
  | "photos.describe"
  | "quota.read"
  | "resource.sample"
  | "run.start"
  | "run.end"
  | "run.error"
  | "run.entered"
  | "source.read"
  | "sync.pull";

/** A run event's line (`run.start`, `run.entered`, `run.end`, `run.error`): every one names its step. */
export interface LogEvent {
  at: string;
  kind: string;
  run?: string;
  step: string;
  [field: string]: unknown;
}

const LOG_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** A `mcp.call` line, as `isReviewCall` (below) reads it. */
export interface Call {
  agent?: string;
  at: string;
  error?: boolean;
  ids?: string[];
  tool?: string;
}

/** derived/log's files, newest first (named by UTC day). */
export const logDays = async (dir = LOG_DIR) =>
  (await filesIn(dir)).filter((n) => LOG_FILE.test(n)).reverse();

/**
 * One day's events whose kind starts with `kind` (`run.`, `email.sent`). A line that does not parse is skipped: a bad
 * line must never stop a reader (the archive reads its incidents here on start).
 */
export const logEvents = <T = Record<string, unknown> & { at: string }>(
  name: string,
  kind: string,
  dir = LOG_DIR
) =>
  linesOf(join(dir, name))
    .filter((l) => l.includes(`"kind":"${kind}`))
    .flatMap((l) => {
      try {
        const e = JSON.parse(l);
        // A line written through LogTape names its instant `time`; older ones `at`.
        return [{ ...e, at: e.at ?? e.time } as T];
      } catch {
        return [];
      }
    });

/** The events of one kind (a prefix: `run.` is every run event) in the newest `days` log files, oldest first. */
export const recentEvents = async <T = LogEvent>(
  days: number,
  kind = "run.",
  dir = LOG_DIR
) =>
  (await logDays(dir))
    .slice(0, days)
    .reverse()
    .flatMap((n) => logEvents<T>(n, kind, dir));

/** The log file an instant's lines go to: one per UTC day. */
export const logFileOf = (at: string) => `${at.slice(0, 10)}.jsonl`;

const lifeLine = logWriter("life", (line, time) => {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, logFileOf(time)), `${line}\n`);
  } catch {
    // Logging must never take the system down; stderr still has it.
    console.error(line);
  }
});

/**
 * `work`, a run of a model on this Mac (`model`: describer, foundation), as one `model.local` line: its duration, how
 * many requests it held and whether it answered (`isOk`, by default when it did not throw).
 */
export async function timedLocalModel<T>(
  model: string,
  count: number,
  work: () => Promise<T>,
  isOk: (t: T) => boolean = () => true
) {
  const started = performance.now();
  const logged = (ok: boolean) =>
    log("model.local", {
      count,
      model,
      ms: Math.round(performance.now() - started),
      ok,
    });
  try {
    const t = await work();
    logged(isOk(t));
    return t;
  } catch (e) {
    logged(false);
    throw e;
  }
}

/** One line of Life's: to the day file of its own instant. */
export function log(kind: LogKind, fields: Record<string, unknown> = {}) {
  lifeLine(kind, fields);
}

/** Whether a connector call came from one of his agents: its grant's agent claim names one (`mcp.call`'s `agent`). */
const isAgent = (agent: unknown) =>
  typeof agent === "string" && agentNames().includes(agent);
/** A call of his agent's daily review: `read_day` read by the agent, with no error (`shownDays`, read-open-items.ts). */
export const isReviewCall = (e: Call) =>
  e.tool === "read_day" && !e.error && isAgent(e.agent);
