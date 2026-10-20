import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, TEST } from "./truth";

// One structured event log for everything Life does, so any failure can be traced afterwards:
// derived/log/YYYY-MM-DD.jsonl, one JSON object per line. Metadata only: counts, ids, durations, statuses,
// error messages. Never message text or quotes (those live in the sources and memory/), with two exceptions:
// `mcp.call` logs the client's question (its arguments, strings clipped to 200 chars) or why it was refused, never the
// answer's text, and
// `lifelog.write` logs the correction it forwards and lifelog's answer.

export const LOG_DIR = TEST
  ? join(tmpdir(), "life-test-log")
  : join(ROOT, "derived", "log");

type LogKind =
  | "email.sent"
  | "event.sent"
  | "file.read"
  | "lifelog.write"
  | "mcp.call"
  | "model.run"
  | "run.start"
  | "run.end"
  | "run.error"
  | "source.read";

/** Every event of one kind logged on `from`'s UTC day or later, oldest first. */
export function logged(kind: LogKind, from = "", dir = LOG_DIR) {
  return (existsSync(dir) ? readdirSync(dir) : [])
    .filter((n) => n.endsWith(".jsonl") && n >= from.slice(0, 10))
    .sort()
    .flatMap((n) => readFileSync(join(dir, n), "utf8").split("\n"))
    .filter((l) => l.includes(`"kind":"${kind}"`))
    .map((l) => JSON.parse(l) as Record<string, unknown> & { at: string });
}

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
