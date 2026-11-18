import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { held, take } from "../core/lock";
import { OWNER_DATA_DIR } from "../core/paths";
import { OUT } from "./memory-files";

// Memory's one lock: everything that writes memory/ holds it (AGENTS.md, "One lock").

/** In the data repo, not in derived/: every worktree shares one lock with production. */
export const LOCK = join(OWNER_DATA_DIR, ".nightly.lock");
/** When the run holding memory's lock took it, or null when none holds it. */
export const lockedSince = () => held(LOCK)?.since ?? null;
/** True while a run holds the lock: the watcher then leaves memory/ and the index alone. */
export const isLocked = () => lockedSince() !== null;
/** Runs `run` holding the lock, so nothing else writes memory/ meanwhile; `null`, without running, when a run holds it. */
export async function locked<T>(run: () => Promise<T>) {
  mkdirSync(OUT, { recursive: true });
  if (!take(LOCK)) {
    console.error("another run is still going");
    return null;
  }
  try {
    return await run();
  } finally {
    rmSync(LOCK, { force: true });
  }
}
