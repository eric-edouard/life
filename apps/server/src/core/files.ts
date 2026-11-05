import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
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
export const rowsOf = <T>(path: string, schema: z.ZodType<T>) =>
  linesOf(path)
    .filter(Boolean)
    .map((l) => schema.parse(JSON.parse(l)));
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
            e.isDirectory() ? newestIn(p, skip) : statSync(p).mtimeMs
          );
        }, 0)
    : 0;
/** The files of a folder with that extension, by name (observations/: one `.jsonl` per month). */
export const filesIn = async (dir: string, ext = ".jsonl") =>
  (await readdir(dir).catch(() => [] as string[]))
    .filter((n) => n.endsWith(ext))
    .sort();
