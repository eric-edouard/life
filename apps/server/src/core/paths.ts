import { cpSync, existsSync, mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// The old names (before 22 Oct 2026) are refused, never read: a copy pointed at by LIFE_DATA must not fall back to his
// live data. Delete this once no shell, script or profile of his sets them.
for (const old of ["LIFE_DATA", "LIFE_STATE", "LIFE_ROOT"]) {
  if (process.env[old]) {
    throw new Error(
      `${old} is no longer read: set LIFE_OWNER_DATA_DIR, LIFE_STATE_DIR or LIFE_CODE_DIR (docs/operations.md)`
    );
  }
}
/** Life's own files (prompts, docs/agent.md, assets): the checkout, or the app's resources (`LIFE_CODE_DIR`). */
export const LIFE_CODE_DIR =
  process.env.LIFE_CODE_DIR ?? join(import.meta.dir, "..", "..", "..", "..");
/** `bun test` sets NODE_ENV=test: tests never touch the real log or data. */
export const TEST = process.env.NODE_ENV === "test";
/** The made-up data tests read (apps/server/src/test-data). */
export const FIXTURES = join(import.meta.dir, "..", "test-data");
/** A path with its links resolved, or as it is when it doesn't exist. */
export const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
/**
 * His data: a local git repo of its own (memory/ and truth/), never pushed. Resolved once, here, like `LIFE_STATE_DIR`: when
 * `~/Life` is a link (to the app's folder), every path Life makes is the real one, so nothing copies or removes
 * through a link. A test run reads its own copy of the
 * made-up data, outside any repo: two runs at once (a push's check beside another session's tests) share no lock or
 * ledger, and none can commit.
 */
export const OWNER_DATA_DIR = real(
  TEST
    ? copied(FIXTURES)
    : (process.env.LIFE_OWNER_DATA_DIR ?? join(homedir(), "Life"))
);
/**
 * Life's own state, never his: its settings, log, the watcher's store, the runs and the search index. A checkout keeps
 * it in its own derived/ (each worktree apart from production); the app sets `LIFE_STATE_DIR`. A test run keeps it in its
 * copy of the data.
 */
export const LIFE_STATE_DIR = real(
  TEST
    ? join(OWNER_DATA_DIR, "state")
    : (process.env.LIFE_STATE_DIR ?? join(LIFE_CODE_DIR, "derived"))
);
/** Does this code run from a repo (a checkout or a worktree) rather than from Life.app's resources? */
export const runsFromRepo = () => existsSync(join(LIFE_CODE_DIR, ".git"));
/**
 * Only the running app migrates his own data (AGENTS.md, "A rename backfills"): a checkout or worktree may migrate a
 * copy, never his live data, which the installed app is still reading.
 */
export const mayMigrate = (data = OWNER_DATA_DIR) =>
  !(runsFromRepo() && isHis(data));
/** Is `data` his own ~/Life (not a copy)? What only a copy may take (`LIFE_LLM`, `LIFE_NOW`) asks this. */
export function isHis(data = OWNER_DATA_DIR) {
  return real(data) === real(join(homedir(), "Life"));
}
// ponytail: each run leaves its ~24 KB copy for the OS to clear (an exit hook doesn't fire under bun test); delete
// old ones here if the temp folder ever matters.
function copied(from: string) {
  const to = mkdtempSync(join(tmpdir(), "life-test-"));
  cpSync(from, to, { recursive: true });
  return to;
}
