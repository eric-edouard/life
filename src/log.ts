import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, TEST } from "./truth";

// One structured event log for everything Life does, so any failure can be traced afterwards:
// derived/log/YYYY-MM-DD.jsonl, one JSON object per line. Metadata only: counts, ids, durations, statuses,
// error messages. Never message text or quotes (those live in the sources and memory/), with two exceptions:
// `mcp.call` logs the client's question (its arguments, strings clipped to 200 chars) and why a request was refused
// before any tool ran, never the answer's text, and
// `lifelog.write` logs the correction it forwards and lifelog's answer.

export const LOG_DIR = TEST
  ? join(tmpdir(), "life-test-log")
  : join(ROOT, "derived", "log");

type LogKind =
  | "email.sent"
  | "file.read"
  | "lifelog.write"
  | "mcp.call"
  | "model.run"
  | "run.start"
  | "run.end"
  | "run.error"
  | "source.read";

export function log(kind: LogKind, fields: Record<string, unknown> = {}) {
  const at = new Date().toISOString();
  const line = JSON.stringify({ at, kind, ...fields });
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, `${at.slice(0, 10)}.jsonl`), `${line}\n`);
  } catch {
    // Logging must never take the system down; stderr still has it.
    console.error(line);
  }
}
