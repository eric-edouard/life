import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
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

// A rename backfills (AGENTS.md): moments become episodes, only what happened (Nov 2026, his OK). memory/moments/
// becomes memory/episodes/: a line that is not `happened` goes (a plan lives as a fact with its `when`), `status`
// goes, `why` becomes `what`, `within` is null. A day's file is code's to rewrite on every reading, so dropping lines
// there moves no cursor. Ids `mom_…` become `ep_…` wherever memory holds them, each line rewritten in place (same
// count, same order); a fact check's kind `moment` becomes `episode`, its group `events` becomes `episodes`. The
// episodes prompt changed with it (v6): each day is read again in full by the backfill, so `why` stands as `what` only
// until then. Memory is written by the app at its next start, under the lock, committed in his data repo before and
// after; run twice, it changes nothing. It goes, once it ran on his data.

/** The migrations done, one line each (memory/migrations.jsonl): this one's name. */
const STEP = "episodes-2026-11";
const DONE = "memory/migrations.jsonl";
const OLD = "memory/moments";
const NEW = "memory/episodes";
/** The files that cite an episode by id; every other memory file cites none. */
const CITING = [
  "memory/ratings.jsonl",
  "memory/statements.jsonl",
  "memory/corrections.jsonl",
  "memory/ledger.jsonl",
];

/** Does this code run from a repo (a checkout or a worktree) rather than from Life.app's resources? */
const runsFromRepo = () => existsSync(join(LIFE_CODE_DIR, ".git"));
/** Only the running app migrates his own data: a checkout or worktree may migrate a copy, never his live data. */
const mayMigrate = (data: string) => !(runsFromRepo() && isHis(data));

/** A text with every `mom_` id as `ep_`, a fact check's kind and group renamed; line for line. */
export const renamedOf = (text: string) =>
  text
    .replace(/\bmom_([0-9a-f]{12})\b/g, "ep_$1")
    .replaceAll('"kind":"moment"', '"kind":"episode"')
    .replaceAll('"group":"events"', '"group":"episodes"');

/** A day's lines as episodes: those that happened, `why` as `what`, `within` null, ids renamed. */
export const dayOf = (text: string) =>
  renamedOf(
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
      .join("")
  );

/** Whole, so a reader never meets half of it. */
const writeWhole = (path: string, text: string) => {
  writeFileSync(`${path}.${process.pid}.tmp`, text);
  renameSync(`${path}.${process.pid}.tmp`, path);
};

const done = (dir: string) =>
  linesOf(join(dir, DONE)).some((l) => l && JSON.parse(l).name === STEP);

/** Is there anything for the rename to do in memory? */
const needsRename = (dir = OWNER_DATA_DIR) =>
  existsSync(join(dir, "memory")) && !done(dir);

/** Memory's moments rewritten as episodes, the ids that cite them renamed, then its line in memory/migrations.jsonl. */
function renameIn(dir: string) {
  const mine = dir === OWNER_DATA_DIR && existsSync(join(dir, ".git"));
  if (mine) {
    commitMemory(["memory"], "Memory: before moments become episodes");
  }
  const from = join(dir, OLD);
  const to = join(dir, NEW);
  mkdirSync(to, { recursive: true });
  for (const f of existsSync(from) ? readdirSync(from) : []) {
    writeWhole(join(to, f), dayOf(readFileSync(join(from, f), "utf8")));
  }
  rmSync(from, { force: true, recursive: true });
  for (const f of CITING) {
    const path = join(dir, f);
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (renamedOf(text) !== text) {
      writeWhole(path, renamedOf(text));
    }
  }
  appendFileSync(
    join(dir, DONE),
    `${JSON.stringify({ at: clock().toISOString(), name: STEP, schemaVersion: 1 })}\n`
  );
  if (mine) {
    commitMemory(
      ["memory"],
      `Memory: moments are episodes, what happened, with what came of it (${STEP})`
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
          `The episodes' rename waits for the watcher of ${holder("watch")?.note} to stop`
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
        'his moments are not episodes yet: only the new Life.app renames them (AGENTS.md, "A rename backfills")'
      );
    }
    // biome-ignore lint/performance/noAwaitInLoops: waits for the process that holds the lock to finish the rename
    const ran = await locked(() => Promise.resolve(step()));
    if (!ran) {
      await Bun.sleep(5000);
    }
  }
}
