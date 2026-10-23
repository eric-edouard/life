import { Database } from "bun:sqlite";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { clock } from "../core/clock";
import { holder } from "../core/lock";
import { log } from "../core/log";
import { mayMigrate, OWNER_DATA_DIR, runsFromRepo } from "../core/paths";
import { locked } from "../memory/memory-lock";
import { commitMemory } from "../memory/run";
import { reindex } from "../memory/search";
import { unitId, VOICE_STEP } from "../memory/units";
import { localDate } from "../memory/zones";
import { storeFiles, WATCH } from "../sources/voice";

// A rename backfills (AGENTS.md): the stored names the owner chose for the voice source on 23 Oct 2026
// (docs/glossary.md), written once into his data by the app at its next start, under the lock, committed in his data
// repo before and after. Every line keeps its place (the `read_memory_changes` cursor and the events' delivery count
// lines); words keep theirs; truth/ and the archive are never read. The rewrite is a pure function of the files
// (`renameStored`), tested on made-up data; `migrateStored` reads, writes and commits. The settings file is renamed
// where it is read (`renamedSettings`, core/settings.ts), the app's Keychain item by the app (Helper.swift).
//
// The renames: a source `lifelog` is `voice` (a unit's `source`, an observation's `source.channel`, a statement's
// `source`, and the same in his regression cases); a label on one of today's chapter units moves to its
// conversation-day (unit ids change recipe from the cutover on, SCHEMA.md "labels.jsonl"); the watcher's store is
// `voice.sqlite`, its conversations' titles blanked and its feed read again (the titles were the server's model ones:
// the feed brings back only his own). The step's line records the cutover (`voiceCutover`, units.ts): today, when memory held lifelog's units.

/** The migrations done, one line each (memory/migrations.jsonl). */
const DONE = "memory/migrations.jsonl";
/** The renamed memory while it is built, and the old one for the moment of the swap. */
const STAGED = "memory.renamed";
const OLD_MEMORY = "memory.old";
/** A memory/ made between the two renames of the swap (by a writer that never waited): settled like the old copy. */
const STRAY = "memory.stray";
const PATHS = ["memory", "docs/evals"];
const OLD = "lifelog";
const NEW = "voice";
/** Keys whose value is a source's name. */
const SOURCE_KEYS = new Set(["channel", "source"]);
const LABELS = "memory/labels.jsonl";
const STORED = /\.(jsonl|json)$/;

const isJsonl = (path: string) => path.endsWith(".jsonl");
/** A line of a stored file, or an error that names the file and the line. */
function parsed(path: string, line: string, i: number) {
  try {
    return JSON.parse(line);
  } catch (e) {
    throw new Error(
      `${path}, line ${i + 1}: not JSON, so its names can't be renamed`,
      { cause: e }
    );
  }
}
const under = (path: string, dir: string) => path.startsWith(`${dir}/`);
const linesOf = (text: string) => text.split("\n").filter((l) => l.trim());

/** Every stored unit, old names and all. */
// biome-ignore lint/suspicious/noExplicitAny: units as stored, read before any schema knows the new name
const unitsIn = (files: Map<string, string>): any[] =>
  [...files]
    .filter(([p]) => under(p, "memory/units") && isJsonl(p))
    .flatMap(([p, text]) => linesOf(text).map((l, i) => parsed(p, l, i)));

/**
 * What a run of the rename on `files` does on `today` (a local day): each chapter unit of today's id to its
 * conversation-day's, and the cutover (today, when memory holds lifelog's units; none on an install that never did).
 */
function planFor(files: Map<string, string>, today: string) {
  const chapters = unitsIn(files).filter((u) => u.source === OLD);
  return {
    cutover: chapters.length > 0 ? today : undefined,
    ids: new Map<string, string>(
      chapters
        .filter((u) => u.date >= today)
        .map((u) => [u.id, unitId(NEW, u.key, u.date)])
    ),
  };
}
type Plan = ReturnType<typeof planFor>;

function value(v: unknown, key: string): unknown {
  if (typeof v === "string") {
    return SOURCE_KEYS.has(key) && v === OLD ? NEW : v;
  }
  if (Array.isArray(v)) {
    return v.map((x) => value(x, key));
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, value(x, k)])
    );
  }
  return v;
}

function row(path: string, r: Record<string, unknown>, { ids }: Plan) {
  const out = value(r, "") as Record<string, unknown>;
  if (path === LABELS && typeof out.unitId === "string") {
    out.unitId = ids.get(out.unitId) ?? out.unitId;
  }
  return out;
}

function renamedFile(path: string, text: string, p: Plan) {
  if (isJsonl(path)) {
    return text
      .split("\n")
      .map((l, i) => {
        if (!l.trim()) {
          return l;
        }
        const was = parsed(path, l, i) as Record<string, unknown>;
        const now = JSON.stringify(row(path, was, p));
        return now === JSON.stringify(was) ? l : now;
      })
      .join("\n");
  }
  const was = JSON.parse(text);
  const now = value(was, "");
  return JSON.stringify(now) === JSON.stringify(was)
    ? text
    : `${JSON.stringify(now, null, 2)}\n`;
}

/**
 * The rename on the owner data dir's stored files (path relative to it -> text) on `today`: the changed files, and the
 * plan it followed. Pure.
 */
export function renameStored(files: Map<string, string>, today: string) {
  const p = planFor(files, today);
  const out = new Map<string, string>();
  for (const [path, text] of files) {
    const next = renamedFile(path, text, p);
    if (next !== text) {
      out.set(path, next);
    }
  }
  return { files: out, plan: p };
}

const done = (dir: string) =>
  existsSync(join(dir, DONE)) &&
  linesOf(readFileSync(join(dir, DONE), "utf8")).some(
    (l) => JSON.parse(l).name === VOICE_STEP
  );

/** The watcher's store under its old name (only this install's, the one `WATCH` names). */
const oldStore = () => join(WATCH, `${OLD}.sqlite`);
/** The store still to move: there under its old name, not yet under its new one (one an old process made again stays). */
const storeToMove = () =>
  existsSync(oldStore()) && !existsSync(storeFiles().file);

/** Is there anything for the rename to do: memory not renamed yet, a run to finish, or the store under its old name? */
export const needsRename = (dir = OWNER_DATA_DIR) =>
  [STAGED, OLD_MEMORY, STRAY].some((d) => existsSync(join(dir, d))) ||
  (existsSync(join(dir, "memory")) && !done(dir)) ||
  (dir === OWNER_DATA_DIR && storeToMove());

/** Every file under `folder`, by its path relative to `dir`. */
function filesUnder(dir: string, folder: string) {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const p = join(at, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else {
        out.push(relative(dir, p));
      }
    }
  };
  if (statSync(join(dir, folder), { throwIfNoEntry: false })?.isFile()) {
    out.push(folder);
  } else if (existsSync(join(dir, folder))) {
    walk(join(dir, folder));
  }
  return out;
}

/** The stored files the rename reads: memory/'s JSON Lines and the regression cases. */
const readStored = (dir: string) =>
  new Map(
    PATHS.flatMap((p) => filesUnder(dir, p))
      .filter((p) => STORED.test(p))
      .map((p) => [p, readFileSync(join(dir, p), "utf8")])
  );

/** Writes a file whole: a reader never meets half of it. */
function writeWhole(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.${process.pid}.tmp`, text);
  renameSync(`${path}.${process.pid}.tmp`, path);
}

const ensureNewline = (s: string) => (s.endsWith("\n") ? s : `${s}\n`);
const todayHere = () => localDate(clock().toISOString());

/**
 * The renamed memory, built whole beside it (memory.renamed/), then swapped in by two renames and settled (`settle`).
 * At a start: a half-built copy with memory/ untouched is built again; a copy built but not swapped in (a crash between
 * the two renames) is swapped in, a memory/ made meanwhile kept aside as a stray; an old copy beside the new memory is
 * settled. Nothing is deleted while an old copy is unsettled.
 */
function renameIn(dir: string) {
  const at = (p: string) => join(dir, p);
  if (existsSync(at(OLD_MEMORY)) && existsSync(at(STAGED))) {
    if (existsSync(at("memory"))) {
      renameSync(at("memory"), at(STRAY));
    }
    renameSync(at(STAGED), at("memory"));
  }
  if (existsSync(at(OLD_MEMORY)) || existsSync(at(STRAY))) {
    return settle(dir);
  }
  rmSync(at(STAGED), { force: true, recursive: true });
  if (dir === OWNER_DATA_DIR && existsSync(at(".git"))) {
    commitMemory(PATHS, "Memory: before the voice source's rename");
  }
  const stored = readStored(dir);
  const { files: renamed, plan: planned } = renameStored(stored, todayHere());
  const staged = (path: string) => join(dir, STAGED, relative("memory", path));
  // A stored file is staged from the text the rename read (a line written since is carried over by `settle`, renamed);
  // any other file is copied.
  for (const path of filesUnder(dir, "memory")) {
    mkdirSync(dirname(staged(path)), { recursive: true });
    const text = stored.get(path);
    if (text === undefined) {
      copyFileSync(at(path), staged(path));
    } else {
      writeFileSync(staged(path), renamed.get(path) ?? text);
    }
  }
  appendFileSync(
    staged(DONE),
    `${JSON.stringify({
      at: clock().toISOString(),
      ...(planned.cutover ? { cutover: planned.cutover } : {}),
      name: VOICE_STEP,
      schemaVersion: 1,
    })}\n`
  );
  renameSync(at("memory"), at(OLD_MEMORY));
  renameSync(at(STAGED), at("memory"));
  return settle(dir);
}

/**
 * After the swap, from the old copy (and a stray memory/ made during it): every line of it, renamed, that the new
 * memory lacks is appended to it (a line written meanwhile without the lock: a correction, a rating, a ledger line);
 * every other stored file of it, renamed, replaces the new one where they differ. The plan comes from the old copy and
 * the recorded cutover, so a settle cut off and run again renames the same way, and adds nothing twice. Then the old
 * copy goes, the regression cases are renamed, and the commit.
 */
function settle(dir: string) {
  const at = (p: string) => join(dir, p);
  const sourceOf = (source: string) =>
    new Map(
      filesUnder(dir, source)
        .map((p) => join("memory", relative(source, p)))
        .filter((p) => STORED.test(p))
        .map(
          (p) =>
            [
              p,
              readFileSync(join(dir, source, relative("memory", p)), "utf8"),
            ] as const
        )
    );
  const recorded = linesOf(readFileSync(at(DONE), "utf8"))
    .map((l) => JSON.parse(l))
    .find((l) => l.name === VOICE_STEP);
  const { plan: planned } = renameStored(
    existsSync(at(OLD_MEMORY)) ? sourceOf(OLD_MEMORY) : new Map(),
    recorded?.cutover ?? todayHere()
  );
  for (const [path, text] of readStored(dir)) {
    const next = under(path, "memory")
      ? text
      : renamedFile(path, text, planned);
    if (next !== text) {
      writeWhole(at(path), next);
    }
  }
  for (const source of [OLD_MEMORY, STRAY].filter((d) => existsSync(at(d)))) {
    carryOver(dir, source, sourceOf(source), planned);
    rmSync(at(source), { force: true, recursive: true });
  }
  if (dir === OWNER_DATA_DIR && existsSync(at(".git"))) {
    commitMemory(PATHS, "Memory: the voice source renamed (docs/glossary.md)");
  }
  log("memory.renamed", {});
}

/**
 * What the new memory lacks of an old copy, renamed: each missing line of a JSON Lines file appended, any other stored
 * file written where it differs (a stray's only where the new memory has none). Run twice, it adds nothing.
 */
function carryOver(
  dir: string,
  source: string,
  old: Map<string, string>,
  planned: Plan
) {
  for (const [path, text] of old) {
    const to = join(dir, path);
    const now = existsSync(to) ? readFileSync(to, "utf8") : "";
    const next = renamedFile(path, text, planned);
    if (isJsonl(path)) {
      const have = new Set(linesOf(now));
      const missing = linesOf(next).filter((l) => !have.has(l));
      if (missing.length > 0) {
        writeWhole(to, `${now && ensureNewline(now)}${missing.join("\n")}\n`);
      }
    } else if (next !== now && !(source === STRAY && now)) {
      writeWhole(to, next);
    }
  }
}

/**
 * The watcher's store under its new name, moved whole (its hearing marks and when each turn arrived are not in the
 * feed): its journal folded in first, its conversations' titles blanked and its cursor dropped, so the feed is read
 * again from the start and brings back only his own titles. A cut-off move is done again from the old file. Once.
 */
function moveStore() {
  if (!storeToMove()) {
    return;
  }
  const db = new Database(oldStore());
  db.run("pragma wal_checkpoint(truncate)");
  db.run("update conversations set title = ''");
  db.close();
  const { cursor, file } = storeFiles();
  rmSync(cursor, { force: true });
  for (const end of ["-wal", "-shm"]) {
    rmSync(`${oldStore()}${end}`, { force: true });
  }
  renameSync(oldStore(), file);
  log("memory.renamed", { store: file });
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
  // The app's own data: a checkout reaches the rename only on a copy (`mayMigrate`), which no other Life watches.
  const live = !runsFromRepo();
  let said = false;
  while (needsRename(dir)) {
    if (!mayMigrate(dir)) {
      throw new Error(
        'his memory has the names from before the voice rename: only the new Life.app renames them (AGENTS.md, "A rename backfills")'
      );
    }
    // biome-ignore lint/performance/noAwaitInLoops: waits for the process that holds the lock to finish the rename
    const ran = await locked(async () => {
      // On the app's data the rename waits for any other watcher (the old app's, a checkout's) to stop.
      if (live && otherWatcher()) {
        if (!said) {
          console.error(
            `the voice source's rename waits for the watcher of ${holder("watch")?.note} to stop`
          );
          said = true;
        }
        return false;
      }
      if (dir === OWNER_DATA_DIR) {
        moveStore();
      }
      if (
        !done(dir) ||
        [STAGED, OLD_MEMORY, STRAY].some((d) => existsSync(join(dir, d)))
      ) {
        renameIn(dir);
        // The index is this process's own data's.
        if (dir === OWNER_DATA_DIR) {
          await reindex().catch((e) =>
            log("run.error", {
              error: (e as Error).message,
              step: "memory.renamed.index",
            })
          );
        }
      }
      return true;
    });
    if (!ran) {
      await Bun.sleep(5000);
    }
  }
}
