import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
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
 * smaller than the file (its line count, its slim rows), or the rows of files read on every call, few of which change
 * (the episodes' days), read often. The value is shared: callers never mutate it.
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

/** What last changed under `paths` (files or folders, walked; a missing one counts nothing): the newest mtime and the bytes in all. Stats only, no read. */
export function readChangeStamp(paths: readonly string[]) {
  let newest = 0;
  let bytes = 0;
  const visit = (path: string) => {
    const s = statSync(path, { throwIfNoEntry: false });
    if (s?.isDirectory()) {
      for (const name of readdirSync(path)) {
        visit(join(path, name));
      }
    } else if (s) {
      newest = Math.max(newest, s.mtimeMs);
      bytes += s.size;
    }
  };
  for (const path of paths) {
    visit(path);
  }
  return `${newest}/${bytes}`;
}

interface Read extends Seen {
  /** The fold so far, of the bytes up to `end` (just past the last newline read). */
  acc: unknown;
  /** The first and the last `EDGE` bytes read, up to `end` (`edgesOf`): a rewrite in place shows there (a migration rewrites every line). */
  edges: Buffer;
  end: number;
}
const EDGE = 1024;

/** The first and the last `EDGE` bytes before `end`, once when they overlap. */
const edgesOf = (path: string, end: number) =>
  Buffer.concat([
    readBytes(path, 0, Math.min(end, EDGE)),
    readBytes(path, Math.max(EDGE, end - EDGE), end),
  ]);

/** Bytes `from` to `to` of the file at `path` (fewer when it is shorter). */
function readBytes(path: string, from: number, to: number) {
  const bytes = Buffer.alloc(Math.max(0, to - from));
  const fd = openSync(path, "r");
  try {
    let n = 0;
    while (n < bytes.length) {
      const got = readSync(fd, bytes, n, bytes.length - n, from + n);
      if (got === 0) {
        break;
      }
      n += got;
    }
    return bytes.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * The complete lines of `path` folded by `fold`, kept per process in `kept` (one fold per path): a change reads only the
 * bytes past the last newline read, unless the file was replaced or rewritten (another inode, shorter, or its first or last
 * bytes read changed), then all of it. `fold` gets the last fold (none: from the start), the byte each new line starts
 * at, the new lines (blanks too) decoded when asked, and the byte past the last; it may throw, which keeps the last read as it was.
 */
// ponytail: a rewrite that keeps the same inode, at least the same size and the same first and last `EDGE` bytes read is taken as
// grown; only code that appends or rewrites every line writes these files.
function foldLines<F>(
  kept: Map<string, Read>,
  path: string,
  empty: () => F,
  fold: (
    last: F | undefined,
    at: number[],
    lines: () => string[],
    end: number
  ) => F
): F {
  const s = statSync(path, { throwIfNoEntry: false });
  if (!s) {
    kept.delete(path);
    return empty();
  }
  const last = kept.get(path);
  if (last && isSameFile(last, s)) {
    return last.acc as F;
  }
  const isGrown =
    last !== undefined &&
    last.ino === s.ino &&
    s.size >= last.end &&
    edgesOf(path, last.end).equals(last.edges);
  const from = isGrown ? last.end : 0;
  const bytes = readBytes(path, from, s.size);
  const at: number[] = [];
  for (
    let i = 0, j = bytes.indexOf(10);
    j >= 0;
    i = j + 1, j = bytes.indexOf(10, i)
  ) {
    at.push(i);
  }
  const end = from + bytes.lastIndexOf(10) + 1;
  // Decoded only when asked: the line index needs none of the text.
  const lines = () =>
    at.map((i, k) => bytes.toString("utf8", i, (at[k + 1] ?? end - from) - 1));
  const acc = fold(
    isGrown ? (last.acc as F) : undefined,
    at.map((i) => from + i),
    lines,
    end
  );
  kept.set(path, {
    acc,
    edges: edgesOf(path, end),
    end,
    ...seenOf(s),
  });
  return acc;
}

/** Every `LINE_STEP`-th line's byte is kept: a page from any line reads at most that many lines before it. */
const LINE_STEP = 1024;
interface LineIndex {
  count: number;
  /** Just past the last newline. */
  end: number;
  /** `starts[k]`: the byte line `k * LINE_STEP` starts at. */
  starts: number[];
}
const lineIndexes = new Map<string, Read>();
/** Where a file's complete lines start (`LineIndex`), read once per process, then only its new bytes. */
const readLineIndex = (path: string) =>
  foldLines<LineIndex>(
    lineIndexes,
    path,
    () => ({ count: 0, end: 0, starts: [] }),
    (last, at, _lines, end) => {
      const starts = [...(last?.starts ?? [])];
      const count = last?.count ?? 0;
      for (const [i, byte] of at.entries()) {
        if ((count + i) % LINE_STEP === 0) {
          starts.push(byte);
        }
      }
      return { count: count + at.length, end, starts };
    }
  );

/** A file's complete lines, blanks included (`linesOf`'s count). */
export const readLineCount = (path: string) => readLineIndex(path).count;

/** A file's complete lines from line `from`, at most `limit`: only their bytes are read (`readLineIndex`), whatever came before. */
export function readLinesFrom(
  path: string,
  from: number,
  limit = Number.POSITIVE_INFINITY
) {
  const ix = readLineIndex(path);
  const to = Math.min(ix.count, from + limit);
  if (from >= to) {
    return [];
  }
  const k = Math.floor(from / LINE_STEP);
  const lines = readBytes(
    path,
    ix.starts[k] ?? 0,
    ix.starts[Math.ceil(to / LINE_STEP)] ?? ix.end
  )
    .toString("utf8")
    .split("\n");
  return lines.slice(from - k * LINE_STEP, to - k * LINE_STEP);
}

const reads = new Map<string, Read>();

/**
 * An append-only file as `add` folds its rows, kept per process (`foldLines`): a read parses only the complete lines
 * appended since the last one, reading only their bytes; a file replaced or rewritten (a migration, a restore, a test)
 * is read whole again. A grown file gets a new result (`start(last)` copies the last one, then its new rows are added),
 * so a result already returned never changes: callers only read it. One fold per path.
 */
// ponytail: the fold stays in memory and grows with its file (verdicts most): keep less state in an only-growing file
// if that bites.
export function readAppended<T, F>(
  path: string,
  schema: z.ZodType<T>,
  start: (last?: F) => F,
  add: (acc: F, row: T) => void
): F {
  return foldLines(reads, path, start, (last, _at, lines) => {
    // Parsed before any is added: a bad line throws and leaves the last read as it was.
    const rows = lines()
      .filter(Boolean)
      .map((l) => schema.parse(JSON.parse(l)));
    const acc = start(last);
    for (const r of rows) {
      add(acc, r);
    }
    return acc;
  });
}
/** Writes a small JSON state file (the schedule's), its folder made if missing. */
export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}
/** Whether `path` exists: false only when it doesn't; throws when it can't be told (access denied), unlike `existsSync`. */
export const isThere = (path: string) =>
  statSync(path, { throwIfNoEntry: false }) !== undefined;

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

/** `why`, unless this process can open `path` (macOS refuses a protected file without Full Disk Access). */
export function unreadable(path: string, why: string) {
  try {
    closeSync(openSync(path, "r"));
  } catch {
    return why;
  }
}
export const FULL_DISK = "Full Disk Access for Life";
