import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../core/platform";

// Claude's own record of each live interactive session (his app's, a terminal's, the desk's own runs): `<pid>.json` in
// `~/.claude/sessions`, gone at its exit. One reader for the desk (whether a session is open, `isSessionOpen`) and the
// agents' read (where it is open, `sessionOpenInOf`).

const CLAUDE_SESSIONS = join(HOME, ".claude", "sessions");

/** Whether process `pid` runs (EPERM: it runs as someone else). */
const isAlive = (pid: unknown) => {
  try {
    return typeof pid === "number" && process.kill(pid, 0);
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
};

/** A live record: its session, what opened it (`entrypoint`: `claude-desktop`, `cli`, `sdk-ts`…) and since when. */
export interface ClaudeSessionRecord {
  entrypoint: string;
  sessionId: string;
  since: string | null;
}

/** Every live record, by session. A record being written or gone is skipped: the next read says. */
export function readClaudeSessionRecords() {
  const live = new Map<string, ClaudeSessionRecord>();
  let names: string[] = [];
  try {
    names = readdirSync(CLAUDE_SESSIONS).filter((n) => n.endsWith(".json"));
  } catch {
    // no record yet
  }
  for (const n of names) {
    try {
      const r = JSON.parse(readFileSync(join(CLAUDE_SESSIONS, n), "utf8"));
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
  return live;
}

/** Where a session the desk does not run is open: his Claude app, or Claude Code elsewhere (a terminal, an editor). */
export type SessionOpenIn = "claude_app" | "claude_code";

/**
 * Where record `r` holds its session open, or null for the desk's own runs (the agent SDK's `sdk-*`, kept between his
 * asks too). ponytail: an orphaned desk run is `sdk-*` too, so it shows nothing here though the desk waits on it.
 */
export const sessionOpenInOf = (
  r: Pick<ClaudeSessionRecord, "entrypoint">
): SessionOpenIn | null => {
  if (r.entrypoint.startsWith("sdk-")) {
    return null;
  }
  return r.entrypoint === "claude-desktop" ? "claude_app" : "claude_code";
};
