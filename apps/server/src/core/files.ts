import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z } from "zod";
/**
 * A file's complete lines (none when it is missing): a line still being appended, with no newline yet, waits for the
 * next read. Synchronous, so the source readers can show what memory/files.jsonl says of their files.
 */
export function linesOf(path: string) {
  const all = (existsSync(path) ? readFileSync(path, "utf8") : "").split("\n");
  all.pop();
  return all;
}
/** A file's rows, every line parsed: for files code rewrites (units/, episodes/); an append-only one is `readAppended`. */
export const rowsOf = <T>(path: string, schema: z.ZodType<T>) =>
  linesOf(path)
    .filter(Boolean)
    .map((l) => schema.parse(JSON.parse(l)));

/** A file as a read saw it: unchanged while its inode, size and mtime are. */
interface Seen {
  ino: number;
  mtimeMs: number;
  size: number;
}
// An unchanged inode, size and mtime is trusted: a same-size rewrite within one mtime tick (APFS: nanoseconds) would
// be missed; only code that appends or rewrites whole writes these files.
const isSameFile = (a: Seen, s: Seen) =>
  a.ino === s.ino && a.size === s.size && a.mtimeMs === s.mtimeMs;
const seenOf = ({ ino, mtimeMs, size }: Seen): Seen => ({ ino, mtimeMs, size });

/**
 * `read` of a file, kept per process: read again only once the file changed (`isSameFile`), whole. For values far
 * smaller than the file (its line count, its slim rows), read often, of files few of which change.
 */
export function keptReader<T>(read: (path: string) => T) {
  const kept = new Map<string, Seen & { value: T }>();
  return (path: string): T => {
    const s = statSync(path, { throwIfNoEntry: false });
    if (!s) {
      kept.delete(path);
      return read(path);
    }
    const last = kept.get(path);
    if (last && isSameFile(last, s)) {
      return last.value;
    }
    const value = read(path);
    kept.set(path, { ...seenOf(s), value });
    return value;
  };
}

/** A file's complete lines, blanks included (`linesOf`'s count). */
export const readLineCount = keptReader((path) => linesOf(path).length);

interface Read extends Seen {
  /** The fold so far, of the bytes up to `end` (just past the last newline read). */
  acc: unknown;
  end: number;
  hash: number | bigint;
}
const reads = new Map<string, Read>();

/**
 * An append-only file as `add` folds its rows, kept per process: a read parses only the complete lines appended since
 * the last one; a file replaced or rewritten (a migration, a restore, a test) is read whole again. A grown file gets
 * a new result (`start(last)` copies the last one, then its new rows are added), so a result already returned never
 * changes: callers only read it. One fold per path.
 */
// ponytail: the fold stays in memory and grows with its file (verdicts most), and a change reads and hashes the whole
// file again (no reparse): keep less state in an only-growing file if that bites.
export function readAppended<T, F>(
  path: string,
  schema: z.ZodType<T>,
  start: (last?: F) => F,
  add: (acc: F, row: T) => void
): F {
  const s = statSync(path, { throwIfNoEntry: false });
  if (!s) {
    reads.delete(path);
    return start();
  }
  const last = reads.get(path);
  if (last && isSameFile(last, s)) {
    return last.acc as F;
  }
  const bytes = readFileSync(path);
  const isGrown =
    last?.ino === s.ino &&
    bytes.length >= last.end &&
    Bun.hash(bytes.subarray(0, last.end)) === last.hash;
  const from = isGrown ? last.end : 0;
  const end = bytes.lastIndexOf(10) + 1;
  // Parsed before any is added: a bad line throws and leaves the last read as it was.
  const rows = new TextDecoder()
    .decode(bytes.subarray(from, end))
    .split("\n")
    .filter(Boolean)
    .map((l) => schema.parse(JSON.parse(l)));
  const acc = start(isGrown ? (last.acc as F) : undefined);
  for (const r of rows) {
    add(acc, r);
  }
  reads.set(path, {
    acc,
    end,
    hash: Bun.hash(bytes.subarray(0, end)),
    ...seenOf(s),
  });
  return acc;
}
/** Writes a small JSON state file (the schedule's, the backfill's), its folder made if missing. */
export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}
/** A small JSON state file, or undefined when it is missing or unreadable. */
export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
/**
 * Appends validated rows, one per line. Synchronous, so nothing runs between a read of the file and the line it allows
 * (an agent task's claim).
 */
export function appendJsonl<T>(path: string, schema: z.ZodType<T>, rows: T[]) {
  if (rows.length > 0) {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      rows.map((r) => `${JSON.stringify(schema.parse(r))}\n`).join("")
    );
  }
}
/** When a file under `dir` last changed, folders named in `skip` aside (ms; 0: no file). */
export const newestIn = (dir: string, skip: string[] = []): number =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => !skip.includes(e.name))
        .reduce((m, e) => {
          const p = join(dir, e.name);
          return Math.max(
            m,
            e.isDirectory()
              ? newestIn(p, skip)
              : // Gone since the listing (an atomic write's rename): it no longer counts.
                (statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0)
          );
        }, 0)
    : 0;
/** The files of a folder with that extension, by name (observations/: one `.jsonl` per month). */
export const filesIn = async (dir: string, ext = ".jsonl") =>
  (await readdir(dir).catch(() => [] as string[]))
    .filter((n) => n.endsWith(ext))
    .sort();
/** Removes the `.json` files of `dir` whose path is not in `keep` (a rebuilt-whole folder: git keeps them); how many. */
export async function removeAllBut(dir: string, keep: ReadonlySet<string>) {
  const gone = (await filesIn(dir, ".json"))
    .map((f) => join(dir, f))
    .filter((path) => !keep.has(path));
  await Promise.all(gone.map((path) => rm(path)));
  return gone.length;
}
