import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { clock } from "../core/clock";
import { linesOf } from "../core/files";
import { holder } from "../core/lock";
import { log } from "../core/log";
import { isHis, LIFE_CODE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { locked } from "../memory/memory-lock";
import { commitMemory } from "../memory/run";

// A rename backfills (AGENTS.md): moments become only what happened (Nov 2026, his OK). In memory/moments/, a line that
// is not `happened` goes (a plan lives as a fact with its `when`); `status` goes; `why` becomes `what`; `within` is
// null. A day's file is code's to rewrite on every reading, so dropping lines there moves no cursor. The moments
// prompt changed with it (v6): each day is read again in full by the backfill, so `why` stands as `what` only until
// then. Memory is written by the app at its next start, under the lock, committed in his data repo before and after;
// run twice, it changes nothing. It goes, once it ran on his data.

/** The migrations done, one line each (memory/migrations.jsonl): this one's name. */
const STEP = "moments-v2-2026-11";
const DONE = "memory/migrations.jsonl";
const MOMENTS = "memory/moments";

/** Does this code run from a repo (a checkout or a worktree) rather than from Life.app's resources? */
const runsFromRepo = () => existsSync(join(LIFE_CODE_DIR, ".git"));
/** Only the running app migrates his own data: a checkout or worktree may migrate a copy, never his live data. */
const mayMigrate = (data: string) => !(runsFromRepo() && isHis(data));

/** A day's moment lines in the new shape: those that happened, `why` as `what`, `within` null; new lines as they are. */
export const dayOf = (text: string) =>
  text
    .split("\n")
    .flatMap((l) => {
      if (!l.trim()) {
        return [];
      }
      const { status, why, ...m } = JSON.parse(l);
      if (status === undefined) {
        return [l];
      }
      return status === "happened"
        ? [JSON.stringify({ ...m, what: why, within: null })]
        : [];
    })
    .map((l) => `${l}\n`)
    .join("");

const done = (dir: string) =>
  linesOf(join(dir, DONE)).some((l) => l && JSON.parse(l).name === STEP);

/** Is there anything for the rename to do in memory? */
export const needsRename = (dir = OWNER_DATA_DIR) =>
  existsSync(join(dir, "memory")) && !done(dir);

/** Memory's moments rewritten, then its line in memory/migrations.jsonl. */
function renameIn(dir: string) {
  const mine = dir === OWNER_DATA_DIR && existsSync(join(dir, ".git"));
  if (mine) {
    commitMemory(["memory"], "Memory: before moments become what happened");
  }
  const days = join(dir, MOMENTS);
  for (const f of existsSync(days) ? readdirSync(days) : []) {
    const path = join(days, f);
    const text = readFileSync(path, "utf8");
    const next = dayOf(text);
    if (next !== text) {
      // Whole, so a reader never meets half of it.
      writeFileSync(`${path}.${process.pid}.tmp`, next);
      renameSync(`${path}.${process.pid}.tmp`, path);
    }
  }
  appendFileSync(
    join(dir, DONE),
    `${JSON.stringify({ at: clock().toISOString(), name: STEP, schemaVersion: 1 })}\n`
  );
  if (mine) {
    commitMemory(
      ["memory"],
      `Memory: moments are what happened, with what came of it (${STEP})`
    );
  }
  log("run.end", { step: `memory.migrate.${STEP}` });
}

/** Another Life's watcher still running (the old app's, or a checkout's): it may write memory/ without the lock. */
const otherWatcher = () => {
  const h = holder("watch");
  return h !== null && h.pid !== String(process.pid);
};

/**
 * Runs the rename once, holding memory's lock, while no other watcher runs: the callers (every command, cli.ts) wait
 * meanwhile. Only the app runs it on his own data (`mayMigrate`): a checkout stops instead.
 */
export async function migrateStored(dir = OWNER_DATA_DIR) {
  const live = !runsFromRepo();
  let said = false;
  /** One try under the lock: true once memory is renamed (by this process or another). */
  const step = () => {
    if (!needsRename(dir)) {
      return true;
    }
    if (live && otherWatcher()) {
      if (!said) {
        console.error(
          `The moments' rename waits for the watcher of ${holder("watch")?.note} to stop`
        );
        said = true;
      }
      return false;
    }
    renameIn(dir);
    return true;
  };
  while (needsRename(dir)) {
    if (!mayMigrate(dir)) {
      throw new Error(
        'his moments still have a status: only the new Life.app renames them (AGENTS.md, "A rename backfills")'
      );
    }
    // biome-ignore lint/performance/noAwaitInLoops: waits for the process that holds the lock to finish the rename
    const ran = await locked(() => Promise.resolve(step()));
    if (!ran) {
      await Bun.sleep(5000);
    }
  }
}
