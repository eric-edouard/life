import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
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

/** A file as a read saw it: unchanged while its inode, birth time, size and mtime are. */
interface Seen {
  birthtimeMs: number;
  ino: number;
  mtimeMs: number;
  size: number;
}
/** The same file, maybe grown: the same inode and birth time (an inode number reused for a new file is born later). */
const isSameNode = (a: Seen, s: Seen) =>
  a.ino === s.ino && a.birthtimeMs === s.birthtimeMs;
// An unchanged inode, size and mtime is trusted: a same-size rewrite within one mtime tick (APFS: nanoseconds) would
// be missed; only code that appends or rewrites whole writes these files.
const isSameFile = (a: Seen, s: Seen) =>
  isSameNode(a, s) && a.size === s.size && a.mtimeMs === s.mtimeMs;
const seenOf = ({ birthtimeMs, ino, mtimeMs, size }: Seen): Seen => ({
  birthtimeMs,
  ino,
  mtimeMs,
  size,
});

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

/**
 * Writes whole or not at all: a temp file beside it, then a rename. A new file, so every process's kept read of it
 * (`readAppended`, `readLines`) reads it whole again: the one way to rewrite an append-only file (a migration, a test).
 */
export function writeWhole(path: string, data: string | Uint8Array) {
  // Each process its own temp file: the app starts several at once, each may rename an old file.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, data);
  renameSync(temp, path);
}

/** The file at `path` opened to read, or undefined when there is none. */
function openIfThere(path: string) {
  try {
    return openSync(path, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw e;
  }
}

/** Bytes `from` to `to` of the open file `fd`; a file that ends before `to` (cut since its stat) throws, keeping the last read. */
function readBytes(fd: number, from: number, to: number) {
  const bytes = Buffer.alloc(Math.max(0, to - from));
  let n = 0;
  while (n < bytes.length) {
    const got = readSync(fd, bytes, n, bytes.length - n, from + n);
    if (got === 0) {
      throw new Error(`file ended at byte ${from + n}, before ${to}`);
    }
    n += got;
  }
  return bytes;
}

/** How many bytes a scan reads at once (more only for a longer line). */
const SCAN = 64 * 1024;

/**
 * The complete lines of the open file `fd` from byte `from` to `size`, `SCAN` bytes at a time: `line` gets each line's
 * first byte and its bytes (no newline). Returns the byte just past the last newline.
 */
function readLinesAt(
  fd: number,
  from: number,
  size: number,
  line: (at: number, bytes: Buffer) => void
) {
  let pos = from;
  let want = SCAN;
  while (pos < size) {
    const bytes = readBytes(fd, pos, Math.min(size, pos + want));
    const last = bytes.lastIndexOf(10);
    if (last < 0) {
      if (pos + bytes.length >= size) {
        break;
      }
      want *= 2;
      continue;
    }
    for (let i = 0, j = bytes.indexOf(10); j >= 0 && j <= last; ) {
      line(pos + i, bytes.subarray(i, j));
      i = j + 1;
      j = bytes.indexOf(10, i);
    }
    pos += last + 1;
    want = SCAN;
  }
  return pos;
}

interface Kept<F> extends Seen {
  /** The fold so far, of the bytes up to `end`. */
  acc: F;
  /** Just past the last newline read. */
  end: number;
}

/**
 * The complete lines of the open file `fd` (at `path`) folded, kept per process in `kept` (one fold per path): a grown
 * file (`isSameNode`, at least as long) is read only past the last newline read; another file (`writeWhole`), or a
 * shorter one, whole. `begin` gets the last fold (none: from the start) and returns a fold of its own, fed every new line
 * (blanks too) and then `done`; it never changes the last fold. Every read ends before `done`, and the fold is kept only
 * once `done` returned: a read or a fold that throws leaves the last one as it was.
 */
// ponytail: a writer that rewrites an append-only file in place, not through `writeWhole`, at least as long, is taken as
// grown: no code does (AGENTS.md, "A rename or a new field backfills"); checking would read the whole file again.
function readFolded<F>(
  kept: Map<string, Kept<F>>,
  path: string,
  fd: number,
  begin: (last: F | undefined) => {
    done: () => F;
    line: (at: number, bytes: Buffer) => void;
  }
): Kept<F> {
  const s = fstatSync(fd);
  const last = kept.get(path);
  if (last && isSameFile(last, s)) {
    return last;
  }
  const isGrown = last && isSameNode(last, s) && s.size >= last.end;
  const fold = begin(isGrown ? last.acc : undefined);
  const end = readLinesAt(fd, isGrown ? last.end : 0, s.size, fold.line);
  const read = { acc: fold.done(), end, ...seenOf(s) };
  kept.set(path, read);
  return read;
}

/** Every `LINE_STEP`-th line's byte is kept: a read from any line reads its block of at most that many lines. */
const LINE_STEP = 1024;
interface LineIndex {
  count: number;
  /** `starts[k]`: the byte line `k * LINE_STEP` starts at. */
  starts: number[];
}
const lineIndexes = new Map<string, Kept<LineIndex>>();
/** Where the open file's complete lines start (`LineIndex`), read once per process, then only its new bytes. */
const readLineIndex = (path: string, fd: number) =>
  readFolded(lineIndexes, path, fd, (last) => {
    const ix = { count: last?.count ?? 0, starts: [...(last?.starts ?? [])] };
    return {
      done: () => ix,
      line: (at) => {
        if (ix.count % LINE_STEP === 0) {
          ix.starts.push(at);
        }
        ix.count += 1;
      },
    };
  });

/** A file's complete lines, blanks included (`linesOf`'s count). */
export function readLineCount(path: string) {
  const fd = openIfThere(path);
  if (fd === undefined) {
    lineIndexes.delete(path);
    return 0;
  }
  try {
    return readLineIndex(path, fd).acc.count;
  } finally {
    closeSync(fd);
  }
}

/**
 * A file's complete lines from line `from` up to line `to`, through one descriptor (a file replaced meanwhile is read
 * as it was), one checkpoint block (`LINE_STEP` lines) at a time: a scan of any length holds one block, and reads the
 * whole blocks its lines are in. Iterate it to its end or break, which closes the file.
 */
export function* readLines(
  path: string,
  from: number,
  to = Number.POSITIVE_INFINITY
) {
  const fd = openIfThere(path);
  if (fd === undefined) {
    lineIndexes.delete(path);
    return;
  }
  try {
    const { acc: ix, end } = readLineIndex(path, fd);
    const stop = Math.min(to, ix.count);
    if (from >= stop) {
      return;
    }
    for (let k = Math.floor(from / LINE_STEP); k * LINE_STEP < stop; k += 1) {
      const block = readBytes(fd, ix.starts[k] ?? 0, ix.starts[k + 1] ?? end)
        .toString("utf8")
        .split("\n");
      const first = k * LINE_STEP;
      for (
        let n = Math.max(from, first);
        n < Math.min(stop, first + LINE_STEP);
        n += 1
      ) {
        yield block[n - first] ?? "";
      }
    }
  } finally {
    closeSync(fd);
  }
}

const reads = new Map<string, Kept<unknown>>();

/**
 * An append-only file as `add` folds its rows, kept per process (`readFolded`): a read parses only the complete lines
 * appended since the last one; a file replaced or rewritten (`writeWhole`: a migration, a restore, a test) is read whole
 * again. A grown file gets a new result (`start(last)` copies the last one, then its new rows are added), so a result
 * already returned never changes: callers only read it. One fold per path.
 */
// ponytail: the fold stays in memory and grows with its file (verdicts most): keep less state in an only-growing file
// if that bites.
export function readAppended<T, F>(
  path: string,
  schema: z.ZodType<T>,
  start: (last?: F) => F,
  add: (acc: F, row: T) => void
): F {
  const kept = reads as Map<string, Kept<F>>;
  const s = statSync(path, { throwIfNoEntry: false });
  const last = kept.get(path);
  if (s && last && isSameFile(last, s)) {
    return last.acc;
  }
  const fd = openIfThere(path);
  if (fd === undefined) {
    kept.delete(path);
    return start();
  }
  try {
    return readFolded(kept, path, fd, (before) => {
      const lines: string[] = [];
      return {
        // Parsed before any is added: a bad line throws and leaves the last read as it was.
        done: () => {
          const rows = lines.map((l) => schema.parse(JSON.parse(l)));
          const acc = start(before);
          for (const r of rows) {
            add(acc, r);
          }
          return acc;
        },
        line: (_, bytes) => {
          if (bytes.length > 0) {
            lines.push(bytes.toString("utf8"));
          }
        },
      };
    }).acc;
  } finally {
    closeSync(fd);
  }
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
