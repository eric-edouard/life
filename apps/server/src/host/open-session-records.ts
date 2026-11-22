import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIFE_STATE_DIR } from "../core/paths";
import { HOME } from "../core/platform";

// The record of each live process holding an agent's session outside the desk's runs: Claude's own (`<pid>.json` in
// `~/.claude/sessions`: his app's, a terminal's, the desk's own runs) and Life's, of a pi session he continues in
// Terminal (`desk/runtimes/pi-terminal.ts`, the same shape, `entrypoint` `life-terminal`). Each is gone, or its pid dead,
// once its process ends. One reader for the desk (whether a session is open, `isSessionOpen`) and the agents' read
// (where it is open, `sessionOpenInOf`).

const CLAUDE_SESSIONS = join(HOME, ".claude", "sessions");
/** Where Life's Terminal launcher writes its record while pi runs there. */
export const TERMINAL_SESSIONS = join(LIFE_STATE_DIR, "desk", "open-sessions");
/** The `entrypoint` of Life's Terminal launcher's records. */
export const TERMINAL_ENTRYPOINT = "life-terminal";

/** Whether process `pid` runs (EPERM: it runs as someone else). */
const isAlive = (pid: unknown) => {
  try {
    return typeof pid === "number" && process.kill(pid, 0);
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
};

/** A live record: its session, what opened it (`entrypoint`: `claude-desktop`, `cli`, `sdk-ts`, `life-terminal`…) and since when. */
export interface OpenSessionRecord {
  entrypoint: string;
  sessionId: string;
  since: string | null;
}

/** Every live record, by session. A record being written or gone is skipped: the next read says. */
export function readOpenSessionRecords(
  dirs = [CLAUDE_SESSIONS, TERMINAL_SESSIONS]
) {
  const live = new Map<string, OpenSessionRecord>();
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      // no record yet
    }
    for (const n of names) {
      try {
        const r = JSON.parse(readFileSync(join(dir, n), "utf8"));
        if (typeof r.sessionId === "string" && isAlive(r.pid)) {
          live.set(r.sessionId, {
            entrypoint: String(r.entrypoint ?? ""),
            sessionId: r.sessionId,
            since:
              typeof r.startedAt === "number"
                ? new Date(r.startedAt).toISOString()
                : null,
          });
        }
      } catch {
        // gone or being written
      }
    }
  }
  return live;
}

/** Where a session the desk does not run is open: his Claude app, Claude Code elsewhere (a terminal, an editor), or pi in Terminal on his Mac. */
export type SessionOpenIn = "claude_app" | "claude_code" | "terminal";

/** Where a session is open outside the desk, in words. */
export const OPEN_IN_WORDS: Record<SessionOpenIn, string> = {
  claude_app: "your Claude app",
  claude_code: "Claude Code",
  terminal: "Terminal on your Mac",
};

/**
 * Where record `r` holds its session open, or null for the desk's own runs (the agent SDK's `sdk-*`, kept between his
 * asks too). ponytail: an orphaned desk run is `sdk-*` too, and a `claude --resume` with no record is found only by the
 * desk's `pgrep`; either shows nothing here though the desk waits on it (its `desk.session_open` line still says so).
 */
export const sessionOpenInOf = (
  r: Pick<OpenSessionRecord, "entrypoint">
): SessionOpenIn | null => {
  if (r.entrypoint.startsWith("sdk-")) {
    return null;
  }
  if (r.entrypoint === TERMINAL_ENTRYPOINT) {
    return "terminal";
  }
  return r.entrypoint === "claude-desktop" ? "claude_app" : "claude_code";
};
