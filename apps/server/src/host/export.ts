import { Database } from "bun:sqlite";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { clock } from "../core/clock";
import { sha256Of } from "../core/hash";
import { LIFE_CODE_DIR, LIFE_STATE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { slashed } from "../core/platform";
import { execOk } from "../core/proc";
import { SECRETS } from "../core/secret";
import { LOCK, locked } from "../memory/memory-lock";
import { INDEX } from "../memory/search";
import { ARCHIVED } from "../memory/sources";
import { ARCHIVE, archiveDb } from "../sources/archived";
import { storeFiles, WATCH } from "../sources/voice";
import { isEmpty } from "./init";

// A whole copy of what Life holds, as a folder (`stage`): `bun life export <dir>`, the app's Export…, and the folder
// the nightly backup snapshots. `data/` his data repo, `state/` Life's state, `archive/` the archive's stores and
// media, and `manifest.json`: every file's size and sha256, and what each part holds (`inventory`). Secrets are never
// in it, only named (`leftOut`): what to give a new install by hand.

export const FORMAT = 1;

/** `p`'s path inside `dir` as an export names it: always with `/`, so an export made on one OS imports on another. */
export const pathIn = (dir: string, p: string) => slashed(relative(dir, p));

/**
 * In Life's state but never exported: rebuilt (the index), the watcher's store (copied whole on its own), and the
 * secrets.
 */
const KEPT_OUT = [WATCH, INDEX, ...Object.values(SECRETS)].map((p) =>
  pathIn(LIFE_STATE_DIR, p)
);
const KEPT_OUT_END = [".bak", ".lock", "-wal", "-shm", ".tmp"];

/** Every file under `dir`, its path relative to `dir` (a link is not a file: a broken one never stops an export). */
export const filesUnder = (dir: string) =>
  (readdirSync(dir, { recursive: true }) as string[])
    .filter((p) => lstatSync(join(dir, p)).isFile())
    .map(slashed);

/**
 * One SQLite file copied whole while it is written to (`VACUUM INTO`: one consistent read, the path a bound value), as a
 * file of its own (a rollback journal, no WAL beside it): it opens anywhere, read-only too, and restores as one file.
 */
function copyDb(from: string, to: string) {
  const source = new Database(from, { readonly: true });
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
  const db = new Database(path, { readonly: true });
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
        .filter((p) => p.endsWith(".sqlite"))
        .map((p) => [p, rowsIn(join(dir, p))])
    ),
  };
}
export type Manifest = Awaited<ReturnType<typeof stage>>;

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
      "the secret files (SECRETS: Life's sign-in, the agent's subscription, the app's key): apps pair again and the agent subscribes again, unless they are copied by hand",
  };
}

/**
 * Stages everything Life holds in `dir` (made, never one with anything in it), consistent: his data cloned under
 * memory's lock (an APFS clone, in ms), each store copied whole by SQLite, the watcher's cursor before its store (the
 * watcher writes it after, so a restored store never lags its cursor). Throws when the lock is held.
 */
export async function stage(dir: string, archive = ARCHIVE) {
  if (!isEmpty(dir)) {
    throw new Error(`${dir} is not empty`);
  }
  mkdirSync(join(dir, "archive"), { recursive: true });
  const cloned = await locked(() => {
    cpSync(OWNER_DATA_DIR, join(dir, "data"), { recursive: true });
    return Promise.resolve(true);
  });
  if (cloned === null) {
    throw new Error("a run holds memory's lock: try again when it is done");
  }
  rmSync(join(dir, "data", basename(LOCK)), { force: true });
  // Life's state inside his data (a test run's is): it goes to state/, through its filter, never with the data.
  const inData = relative(OWNER_DATA_DIR, LIFE_STATE_DIR);
  if (!(inData.startsWith("..") || isAbsolute(inData))) {
    rmSync(join(dir, "data", inData), { force: true, recursive: true });
  }
  cpSync(LIFE_STATE_DIR, join(dir, "state"), { recursive: true });
  for (const p of filesUnder(join(dir, "state"))) {
    if (
      KEPT_OUT.some((k) => p === k || p.startsWith(`${k}/`)) ||
      KEPT_OUT_END.some((e) => p.endsWith(e))
    ) {
      rmSync(join(dir, "state", p), { force: true });
    }
  }
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
  const files: { path: string; sha256: string; size: number }[] = [];
  for (const path of filesUnder(dir)) {
    files.push({
      path,
      // biome-ignore lint/performance/noAwaitInLoops: one file at a time, streamed: the media alone is gigabytes
      sha256: await sha256Of(join(dir, path)),
      size: statSync(join(dir, path)).size,
    });
  }
  const manifest = {
    counts: await inventory(dir),
    createdAt: clock().toISOString(),
    files,
    format: FORMAT,
    leftOut: leftOut(),
  };
  writeFileSync(
    join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
}
