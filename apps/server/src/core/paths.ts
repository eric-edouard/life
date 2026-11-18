import { cpSync, existsSync, mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Life's own files (prompts, assets): the checkout, or the app's resources (`LIFE_CODE_DIR`). The app's compiled helper
 * has no checkout around it and runs only with the app's environment (its paths and Keychain secrets): run by hand, it
 * stops here; by hand, use the checkout's `bun life`.
 */
if (!process.env.LIFE_CODE_DIR && import.meta.dir.startsWith("/$bunfs")) {
  throw new Error(
    "Life's helper runs from Life.app only; by hand, use `bun life` in a checkout"
  );
}
export const LIFE_CODE_DIR =
  process.env.LIFE_CODE_DIR ?? join(import.meta.dir, "..", "..", "..", "..");
/** `bun test` sets NODE_ENV=test: tests never touch the real log or data, nor mail with his key (a test sets its own). */
export const TEST = process.env.NODE_ENV === "test";
if (TEST) {
  delete process.env.RESEND_PERSONAL_API_KEY;
}
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
/** The desk's store (`apps/server/src/desk/`): his registered agents, their waits, turns and queued events. Host reads it read-only. */
export const DESK_STORE = join(LIFE_STATE_DIR, "desk", "desk.sqlite");
/** Where an agent started with no folder (and no repo of its project on the Mac) runs: a folder of its own, `<agt_…>`, made by the desk. */
export const DESK_AGENT_FOLDERS = join(LIFE_STATE_DIR, "desk", "agents");
/** Is `data` his own ~/Life (not a copy)? What only a copy may take (`LIFE_LLM`) asks this. */
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
