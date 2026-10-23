// The archive as a folder, and back: `voice-server export|import <folder>` (index.ts), the Mac
// host's Export… and Import…, and what the daily restic backup snapshots (restic.ts). The folder
// holds `archive.sqlite`, the audio under `audio/` (AUDIO_DIR's files, keys as paths), and
// `manifest.json`: each file's size and sha256, and each table's rows. Shaped like Life's.
import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { sha256Of } from "@life/server/src/core/hash";
import { connect, type Db, holdArchive, migrateDb } from "@life/voice-db";
import { sql } from "drizzle-orm";
import { keyPath } from "./audio-store";

const FORMAT = 1;
const ARCHIVE = "archive.sqlite";
const AUDIO = "audio/";

interface Manifest {
  app: "lifelog";
  counts: Record<string, number>;
  createdAt: string;
  files: Record<string, { sha256: string; size: number }>;
  format: number;
}

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

// Every file under `dir` (none when it doesn't exist), as paths relative to it with `/`, as audio keys and the
// manifest write them on every OS.
async function filesUnder(dir: string) {
  const paths = await readdir(dir, { recursive: true }).catch((error) =>
    missing(error) ? [] : Promise.reject(error)
  );
  const files: string[] = [];
  for (const path of paths) {
    // biome-ignore lint/performance/noAwaitInLoops: one stat at a time
    if ((await lstat(join(dir, path))).isFile()) {
      files.push(path.split(sep).join("/"));
    }
  }
  return files;
}

// A clone where the disk can (APFS), its mtime kept, so restic reads again only what changed.
async function copyKept(from: string, to: string) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to, constants.COPYFILE_FICLONE);
  const { atime, mtime } = await lstat(from);
  await utimes(to, atime, mtime);
}

function rowsIn(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    const tables = db
      .query<{ name: string }, []>(
        `select name from sqlite_master where type = 'table'
          and name not like 'sqlite_%' and name not like 'search_text%'`
      )
      .all();
    return Object.fromEntries(
      tables.map(({ name }) => [
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

// Writes the export into `folder` (made if missing, refused unless empty), safe while the server
// runs. The archive is copied first, then the audio: a fragment joined meanwhile is missing (the
// cutter withdraws it and the phone sends it again), never a job's audio. Left out: `.part` files
// being written, and `archive/`, the daily snapshots (backup.ts), which archive.sqlite supersedes.
// ponytail: every file is read again for its sha256, a few minutes a day at tens of GB; take the
// sha in an audio key's name if that ever matters.
export async function exportArchive(
  db: Db,
  audioDir: string | undefined,
  folder: string
) {
  if ((await readdir(folder).catch(() => [])).length > 0) {
    throw new Error(`${folder} is not empty`);
  }
  await mkdir(folder, { recursive: true });
  try {
    // Consistent while the server writes; its keyword index is rebuilt where it is restored.
    db.run(sql`vacuum into ${join(folder, ARCHIVE)}`);
    const keys = audioDir ? await filesUnder(audioDir) : [];
    for (const key of keys) {
      if (key.endsWith(".part") || key.startsWith("archive/")) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: one file at a time
      await copyKept(
        join(audioDir as string, key),
        join(folder, AUDIO, key)
      ).catch((error) => (missing(error) ? undefined : Promise.reject(error)));
    }
    const files: Manifest["files"] = {};
    for (const path of await filesUnder(folder)) {
      files[path] = {
        // biome-ignore lint/performance/noAwaitInLoops: one file at a time, streamed
        sha256: await sha256Of(join(folder, path)),
        size: (await lstat(join(folder, path))).size,
      };
    }
    const manifest: Manifest = {
      app: "lifelog",
      counts: rowsIn(join(folder, ARCHIVE)),
      createdAt: new Date().toISOString(),
      files,
      format: FORMAT,
    };
    await writeFile(
      join(folder, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    return totals(manifest);
  } catch (error) {
    await emptied(folder);
    throw error;
  }
}

const totals = (m: Manifest) => ({
  bytes: Object.values(m.files).reduce((sum, f) => sum + f.size, 0),
  files: Object.keys(m.files).length,
});

async function emptied(folder: string) {
  for (const entry of await readdir(folder).catch(() => [])) {
    // biome-ignore lint/performance/noAwaitInLoops: a few entries
    await rm(join(folder, entry), { force: true, recursive: true });
  }
}

// Conversations and jobs in the archive at `file`; 0 when there is none, or no table yet.
function heldIn(file: string) {
  if (!Bun.file(file).size) {
    return 0;
  }
  // Not read-only: a WAL file left without its `-shm` opens only so (no server runs).
  const db = new Database(file, { readwrite: true });
  try {
    const row = db
      .query(
        "select (select count(*) from conversations) + (select count(*) from transcription_jobs) as n"
      )
      .get() as { n: number };
    return row.n;
  } catch (error) {
    if (String(error).includes("no such table")) {
      return 0;
    }
    throw error;
  } finally {
    db.close();
  }
}

// Where a manifest's path goes: the archive, or an audio key (never `..`, never absolute).
function destination(path: string, side: { audio: string; db: string }) {
  if (path === ARCHIVE) {
    return side.db;
  }
  if (!path.startsWith(AUDIO)) {
    throw new Error(`${path} is no file of an export`);
  }
  return keyPath(side.audio, path.slice(AUDIO.length));
}

const matches = async (file: string, want: { sha256: string; size: number }) =>
  (await lstat(file).catch(() => null))?.size === want.size &&
  (await sha256Of(file)) === want.sha256;

// Whether AUDIO_DIR holds the export's audio already: none (false), or exactly it (true: a
// re-run after an import that crashed between its two renames). Anything else is refused.
async function audioThere(audioDir: string, m: Manifest) {
  const there = await filesUnder(audioDir);
  const wanted = Object.keys(m.files).filter((p) => p.startsWith(AUDIO));
  for (const key of there) {
    const want = m.files[AUDIO + key];
    if (
      there.length !== wanted.length ||
      !want ||
      // biome-ignore lint/performance/noAwaitInLoops: one file at a time, streamed
      !(await matches(join(audioDir, key), want))
    ) {
      throw new Error(`${audioDir} holds audio already`);
    }
  }
  return there.length > 0;
}

// The copied archive holds the rows the export counted; then it is migrated, its keyword index
// rebuilt (`VACUUM INTO` may renumber the passages' rowids, which `search_text` follows), and made
// one file again (no WAL beside it), so it moves in by one rename.
function settleArchive(file: string, m: Manifest) {
  const counts = rowsIn(file);
  const off = Object.keys(m.counts).filter((t) => counts[t] !== m.counts[t]);
  if (off.length > 0) {
    throw new Error(`archive.sqlite is not as counted (${off.join(", ")})`);
  }
  const db = connect(file);
  migrateDb(db);
  db.$client.run("insert into search_text(search_text) values ('rebuild')");
  db.$client.run("pragma journal_mode = delete");
  db.$client.close(true);
}

// Puts an export back into a new install, all or nothing, with the server stopped (its lock is
// taken). Refused over an archive holding conversations or jobs, or audio other than the export's.
// Every file is checked against the manifest before anything is written, copied beside its place
// (`*.importing`), the archive counted and migrated, then both moved in, the archive last.
export async function importArchive(
  folder: string,
  databasePath: string,
  audioDir: string
) {
  await mkdir(dirname(databasePath), { recursive: true });
  const lock = holdArchive(databasePath);
  const side = {
    audio: `${audioDir}.importing`,
    db: `${databasePath}.importing`,
  };
  const clean = () =>
    Promise.all(
      [side.audio, side.db, `${side.db}-wal`, `${side.db}-shm`].map((path) =>
        rm(path, { force: true, recursive: true })
      )
    );
  try {
    const m = JSON.parse(
      await readFile(join(folder, "manifest.json"), "utf8")
    ) as Manifest;
    if (m.app !== "lifelog" || m.format !== FORMAT || !m.files[ARCHIVE]) {
      throw new Error(`not a Life export of format ${FORMAT}`);
    }
    if (heldIn(databasePath) > 0) {
      throw new Error(`${databasePath} holds an archive already`);
    }
    const kept = await audioThere(audioDir, m);
    const files = Object.entries(m.files)
      .map(([path, want]) => ({
        from: join(folder, path),
        path,
        to: destination(path, side),
        want,
      }))
      .filter((f) => !(kept && f.path.startsWith(AUDIO)));
    for (const f of files) {
      // biome-ignore lint/performance/noAwaitInLoops: one file at a time, streamed
      if (!(await matches(f.from, f.want))) {
        throw new Error(`${f.path} is not as exported`);
      }
    }
    await clean();
    await mkdir(side.audio, { recursive: true });
    for (const f of files) {
      // biome-ignore lint/performance/noAwaitInLoops: one file at a time
      await copyKept(f.from, f.to);
    }
    settleArchive(side.db, m);
    if (!kept) {
      // Empty but for folders (checked above).
      await rm(audioDir, { force: true, recursive: true });
      await rename(side.audio, audioDir);
    }
    // The empty archive's journal goes with it.
    await Promise.all(
      ["-wal", "-shm"].map((end) =>
        rm(`${databasePath}${end}`, { force: true })
      )
    );
    await rename(side.db, databasePath);
    await clean();
    return totals(m);
  } catch (error) {
    await clean();
    throw new Error(`${(error as Error).message}: nothing was changed`, {
      cause: error,
    });
  } finally {
    lock.close();
  }
}

// `voice-server export|import <folder>` with DATABASE_PATH and AUDIO_DIR: one JSON line,
// `{ ok, files, bytes }`, or `{ ok: false, error }` and exit code 1.
export async function runCommand(
  [command, folder]: string[],
  env: Record<string, string | undefined>
) {
  const { AUDIO_DIR: audioDir, DATABASE_PATH: databasePath } = env;
  try {
    if (!(folder && databasePath && (audioDir || command === "export"))) {
      throw new Error(
        "usage: voice-server export|import <folder>, with DATABASE_PATH and AUDIO_DIR set"
      );
    }
    const result =
      command === "export"
        ? await exportArchive(
            connect(databasePath, { readonly: true }),
            audioDir,
            folder
          )
        : await importArchive(folder, databasePath, audioDir as string);
    console.log(JSON.stringify({ ok: true, ...result }));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ error: (error as Error).message, ok: false }));
    return 1;
  }
}
