import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { clock } from "./clock";
import { filesIn, linesOf } from "./files";
import { LIFE_STATE_DIR } from "./paths";
import { pulls, settings } from "./settings";

// One structured event log for everything Life does, so any failure can be traced afterwards:
// derived/log/YYYY-MM-DD.jsonl, one JSON object per line. Metadata only: counts, ids, durations, statuses,
// error messages. Never message text or quotes (those live in the sources and memory/), with two exceptions:
// `mcp.call` logs the client's question (its arguments, strings clipped to 200 chars) or why it was refused, never the
// answer's text, and
// `lifelog.write` logs the correction it forwards and lifelog's answer.

export const LOG_DIR = join(LIFE_STATE_DIR, "log");

type LogKind =
  | "board.write"
  | "calendar.write"
  | "email.sent"
  | "event.sent"
  | "file.read"
  | "lifelog.write"
  | "mcp.call"
  | "memory.renamed"
  | "model.run"
  | "quota.read"
  | "run.start"
  | "run.end"
  | "run.error"
  | "run.phase"
  | "source.read"
  | "sync.pull";

/** A run event's line (`run.start`, `run.phase`, `run.end`, `run.error`): every one names its step. */
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
 * One day's events whose kind starts with `kind` (`run.`, `event.sent`). A line that does not parse is skipped: a bad
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
        return [JSON.parse(l) as T];
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

export function log(kind: LogKind, fields: Record<string, unknown> = {}) {
  const at = clock().toISOString();
  const line = JSON.stringify({ at, kind, ...fields });
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, `${at.slice(0, 10)}.jsonl`), `${line}\n`);
  } catch {
    // Logging must never take the system down; stderr still has it.
    console.error(line);
  }
}
/** Whether a connector call came from his agent: its user agent starts with the `agent` setting's `client`. */
export const isAgent = (agent: unknown) => {
  const a = settings().agent;
  const client = a && (a.client ?? (pulls() ? "Claude" : "openai-mcp"));
  return !!client && String(agent ?? "").startsWith(client);
};
/** A call of his agent's daily review: `read_day` read by the agent, with no error (the nightly's `reviewed`, `shownDays`). */
export const isReviewCall = (e: Call) =>
  e.tool === "read_day" && !e.error && isAgent(e.agent);
