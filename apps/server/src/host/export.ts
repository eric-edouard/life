import {
  accessSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { clock } from "../core/clock";
import { sha256Of } from "../core/hash";
import {
  DESK_STORE,
  LIFE_CODE_DIR,
  LIFE_STATE_DIR,
  OWNER_DATA_DIR,
  PROJECT_WORK_FOLDERS,
} from "../core/paths";
import { pathInside, slashed } from "../core/platform";
import { execOk } from "../core/proc";
import { SECRETS } from "../core/secret";
import { openReadOnly } from "../core/sqlite";
import {
  EXCHANGE_COUNTS,
  INDEX,
  MENTIONS,
  PASSAGES,
  RECORDED_DAYS,
  VECTORS,
} from "../memory/memory-files";
import { LOCK, locked } from "../memory/memory-lock";
import { ARCHIVED } from "../memory/sources";
import { ARCHIVE, archiveDb } from "../sources/archived";
import { storeFiles, WATCH } from "../sources/voice-server";
import { notesOutsideOf } from "./desk-read";
import { isEmpty } from "./init";

// A whole copy of what Life holds, as a folder (`stage`): `bun life export <dir>`, the app's Export…, and the folder
// the nightly backup snapshots. `data/` his data repo, `state/` Life's state, `archive/` the archive's stores and
// media, `notes/` each desk assignment's notes file kept outside Life's state (`<asg>.md`), and `manifest.json`: every file's size and sha256, and what each part holds (`inventory`). Secrets are never
// in it, only named (`leftOut`): what to give a new install by hand.

export const FORMAT = 1;

/** `p`'s path inside `dir` as an export names it: always with `/`, so an export made on one OS imports on another. */
export const pathIn = (dir: string, p: string) => slashed(relative(dir, p));

/**
 * In Life's state but never exported: rebuilt (the index, passages, vectors, the exchange counts, the mentions, the recorded days), the watcher's store (copied whole on its own) and the
 * secrets.
 */
const KEPT_OUT = [
  WATCH,
  INDEX,
  PASSAGES,
  VECTORS,
  EXCHANGE_COUNTS,
  MENTIONS,
  RECORDED_DAYS,
  ...Object.values(SECRETS),
].map((p) => pathIn(LIFE_STATE_DIR, p));
/** One-off projects' work folders (`projects/<id>/`) in an export's `state/`. */
export const PROJECTS_IN_STATE = pathIn(LIFE_STATE_DIR, PROJECT_WORK_FOLDERS);
/** Inside a project's work folder, never exported: its `.git` (history is not backed up: life#1607), its secret files (any name starting `.env`) and its installed packages and build caches (its agent reinstalls packages after a restore; the owner, 28 Nov 2026). */
const PROJECT_KEPT_OUT =
  /(^|\/)(node_modules|\.git|\.cache|\.turbo|\.next|\.env[^/]*)(\/|$)/;
/** Life's own leftovers, never exported; a project's files of these names are its own, and kept. */
const KEPT_OUT_END = [".bak", ".lock", ".tmp"];
/** A store's files beside it: its copy (`copyDb`) is one whole file, and a rollback journal left beside it would be rolled onto that copy at its first open. */
const DB_SIDE_FILES = ["-wal", "-shm", "-journal"];

/** Whether `file` is a SQLite database, by its header: a live store (WAL) is copied by SQLite, whatever its name. */
const isDb = (file: string) => {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    return head.toString("latin1") === "SQLite format 3\0";
  } finally {
    closeSync(fd);
  }
};

/**
 * Whether the state file `p` (inside Life's state) is copied: never a kept-out one; in a project's work folder, only
 * folders and plain files it can read (a link could carry a secret file out; a socket, a pipe or an unreadable file
 * would stop the whole backup), the others named in `notCopied`.
 */
function isCopied(p: string, from: string, notCopied: string[]) {
  if (KEPT_OUT.some((k) => p === k || p.startsWith(`${k}/`))) {
    return false;
  }
  if (!p.startsWith(`${PROJECTS_IN_STATE}/`)) {
    return true;
  }
  if (PROJECT_KEPT_OUT.test(p.slice(PROJECTS_IN_STATE.length))) {
    return false;
  }
  const f = lstatSync(from);
  try {
    accessSync(
      from,
      f.isDirectory() ? constants.R_OK | constants.X_OK : constants.R_OK
    );
  } catch {
    notCopied.push(`state/${p}`);
    return false;
  }
  if (f.isFile() || f.isDirectory()) {
    return true;
  }
  if (!f.isSymbolicLink()) {
    notCopied.push(`state/${p}`);
  }
  return false;
}

/** Every file under `dir`, its path relative to `dir` (a link is not a file: a broken one never stops an export). */
export const filesUnder = (dir: string) =>
  (readdirSync(dir, { recursive: true }) as string[])
    .filter((p) => lstatSync(join(dir, p)).isFile())
    .map(slashed);

/**
 * One SQLite file copied whole while it is written to (`VACUUM INTO`: one consistent read, the path a bound value), as a
 * file of its own (a rollback journal, no WAL beside it): it opens anywhere, read-only too, and restores as one file.
 */
export function copyDb(from: string, to: string) {
  const source = openReadOnly(from);
  try {
    source.run("VACUUM INTO ?", [to]);
  } finally {
    source.close();
  }
}

/** Lines per JSONL file of a data folder (its repo's own files aside). */
export const linesIn = (data: string) =>
  Object.fromEntries(
    filesUnder(data)
      .filter((p) => p.endsWith(".jsonl") && !p.startsWith(".git"))
      .map((p) => [
        p,
        readFileSync(join(data, p), "utf8").split("\n").filter(Boolean).length,
      ])
  );

/** Rows per table of one SQLite file. */
export function rowsIn(path: string) {
  const db = openReadOnly(path);
  try {
    return Object.fromEntries(
      db
        .query<{ name: string }, []>(
          "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
        )
        .all()
        .map(({ name }) => [
          name,
          (
            db.query(`select count(*) as n from "${name}"`).get() as {
              n: number;
            }
          ).n,
        ])
    );
  } finally {
    db.close();
  }
}

/** A data folder's commit, or null when it is no repo. */
export const headOf = async (data: string) =>
  existsSync(join(data, ".git"))
    ? (await execOk(["git", "-C", data, "rev-parse", "HEAD"])).trim()
    : null;

/** What a staged folder holds: lines per JSONL file of his data, rows per table of each store, the data's commit. */
export async function inventory(dir: string) {
  return {
    head: await headOf(join(dir, "data")),
    lines: linesIn(join(dir, "data")),
    rows: Object.fromEntries(
      filesUnder(dir)
        .filter((p) => isDb(join(dir, p)))
        .map((p) => [p, rowsIn(join(dir, p))])
    ),
  };
}
export type Manifest = Awaited<ReturnType<typeof stage>>;
/** A staged file as the manifest lists it (restore checks `sha256`; `mtime` only spares the next staging a hash). */
interface StagedFile {
  mtime: number;
  path: string;
  sha256: string;
  size: number;
}

const ENV_KEY = /^([A-Z0-9_]+)=/;
/** What a new install is given by hand, named only: never their values. */
function leftOut() {
  const env = join(LIFE_CODE_DIR, ".env");
  return {
    codex:
      "Codex's login, on another Mac (`codex login`, for the codex engine)",
    env: existsSync(env)
      ? readFileSync(env, "utf8")
          .split("\n")
          .flatMap((l) => l.match(ENV_KEY)?.[1] ?? [])
      : [],
    keychain:
      "every item of the service Life (the app keeps its secrets there)",
    secrets:
      "the secret files (SECRETS: Life's sign-in, the ask cursor, the app's key, the bridges' account, gog's keyring password): apps pair again and the bridges' account logs in again, unless they are copied by hand",
  };
}

/** The desk's notes kept in his agents repo, as `notes/<asg>.md`: the staged store names them, so a restore puts them back where it says. */
function stageNotes(dir: string) {
  const desk = join(dir, "state", relative(LIFE_STATE_DIR, DESK_STORE));
  for (const s of existsSync(desk)
    ? notesOutsideOf(desk, LIFE_STATE_DIR)
    : []) {
    if (existsSync(s.notes_path)) {
      mkdirSync(join(dir, "notes"), { recursive: true });
      cpSync(s.notes_path, join(dir, "notes", `${s.id}.md`));
    }
  }
}

/**
 * Where Life's state sits inside his data (`state`'s path under `data`), else null. Refused when they are one folder:
 * the data's copy would carry the state's secrets past the state's filter (SECURITY.md).
 */
export function stateInDataOf(data: string, state: string) {
  const inData = pathInside(data, state);
  if (inData === "") {
    throw new Error(
      `${state} is Life's data folder too: an export would carry its secrets; nothing was staged`
    );
  }
  return inData;
}

/**
 * Stages everything Life holds in `dir` (made, never one with anything in it), consistent: his data cloned under
 * memory's lock (an APFS clone, in ms), each store copied whole by SQLite, the watcher's cursor before its store (the
 * watcher writes it after, so a restored store never lags its cursor). Throws when the lock is held. A file of the
 * same path, size and mtime as in `previous` (the last staging's manifest) keeps its hash, as restic trusts the same:
 * the folder clones keep mtimes, the stores' copies are new files and always hashed.
 */
export async function stage(
  dir: string,
  archive = ARCHIVE,
  previous: StagedFile[] = []
) {
  if (!isEmpty(dir)) {
    throw new Error(`${dir} is not empty`);
  }
  const inData = stateInDataOf(OWNER_DATA_DIR, LIFE_STATE_DIR);
  mkdirSync(join(dir, "archive"), { recursive: true });
  const cloned = await locked(() => {
    // Life's state inside his data (a test run's is): it goes to state/, through its filter, never with the data.
    cpSync(OWNER_DATA_DIR, join(dir, "data"), {
      recursive: true,
      ...(inData && {
        filter: (from: string) => pathIn(OWNER_DATA_DIR, from) !== inData,
      }),
    });
    return Promise.resolve(true);
  });
  if (cloned === null) {
    throw new Error("a run holds memory's lock: try again when it is done");
  }
  rmSync(join(dir, "data", basename(LOCK)), { force: true });
  const notCopied: string[] = [];
  cpSync(LIFE_STATE_DIR, join(dir, "state"), {
    // Never copied: a kept-out folder (a work folder's packages) would cost a copy only to be removed.
    filter: (from) => isCopied(pathIn(LIFE_STATE_DIR, from), from, notCopied),
    recursive: true,
  });
  for (const p of filesUnder(join(dir, "state"))) {
    const staged = join(dir, "state", p);
    const inProject = p.startsWith(`${PROJECTS_IN_STATE}/`);
    if (
      DB_SIDE_FILES.some((e) => p.endsWith(e)) ||
      (!inProject && KEPT_OUT_END.some((e) => p.endsWith(e)))
    ) {
      rmSync(staged, { force: true });
    } else if (isDb(staged)) {
      // A store (the photo descriptions, a project's) is written meanwhile, in WAL: copied whole by SQLite like the
      // archive's, never as a file without its -wal, which no reader opens.
      rmSync(staged);
      try {
        copyDb(join(LIFE_STATE_DIR, p), staged);
      } catch (e) {
        // A project's store that won't copy (corrupt, locked) is left out and named; Life's own stops the export.
        if (!inProject) {
          throw e;
        }
        rmSync(staged, { force: true });
        notCopied.push(`state/${p}`);
      }
    }
  }
  stageNotes(dir);
  const watch = join(dir, "state", relative(LIFE_STATE_DIR, WATCH));
  mkdirSync(watch, { recursive: true });
  const { cursor, file } = storeFiles();
  if (existsSync(cursor)) {
    cpSync(cursor, join(watch, basename(cursor)));
  }
  if (existsSync(file)) {
    await copyDb(file, join(watch, basename(file)));
  }
  for (const db of ARCHIVED.map((s) => archiveDb(s.name, archive)).filter(
    existsSync
  )) {
    // biome-ignore lint/performance/noAwaitInLoops: one copy at a time
    await copyDb(db, join(dir, "archive", basename(db)));
  }
  if (existsSync(join(archive, "media"))) {
    cpSync(join(archive, "media"), join(dir, "archive", "media"), {
      recursive: true,
    });
  }
  const before = new Map(previous.map((f) => [f.path, f]));
  const files: StagedFile[] = [];
  for (const path of filesUnder(dir)) {
    const { mtimeMs: mtime, size } = statSync(join(dir, path));
    const was = before.get(path);
    const sha256 =
      was?.size === size && was.mtime === mtime
        ? was.sha256
        : // biome-ignore lint/performance/noAwaitInLoops: one file at a time, streamed: the media alone is gigabytes
          await sha256Of(join(dir, path));
    files.push({ mtime, path, sha256, size });
  }
  const manifest = {
    counts: await inventory(dir),
    createdAt: clock().toISOString(),
    files,
    format: FORMAT,
    leftOut: leftOut(),
    /** A project's files that could not be copied (a socket, an unreadable file, a store that won't open): left out. */
    notCopied,
  };
  writeFileSync(
    join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
}
