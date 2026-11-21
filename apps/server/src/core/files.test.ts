import { expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  keptReader,
  readAppended,
  readLineCount,
  readLines,
  writeWhole,
} from "./files";

test("an append-only file is folded once: grown, rewritten, a partial last line, a bad line", () => {
  const path = join(mkdtempSync(join(tmpdir(), "life-files-")), "f.jsonl");
  let parsed = 0;
  const row = z.number().transform((n) => {
    parsed += 1;
    return n;
  });
  const read = () =>
    readAppended(
      path,
      row,
      (last?: number[]) => [...(last ?? [])],
      (all, n) => {
        all.push(n);
      }
    );
  expect(read()).toEqual([]);
  writeFileSync(path, "1\n2\n3");
  const first = read();
  expect(first).toEqual([1, 2]);
  expect(read()).toBe(first);
  appendFileSync(path, "\n4\n");
  expect(read()).toEqual([1, 2, 3, 4]);
  expect(first).toEqual([1, 2]);
  expect(parsed).toBe(4);
  writeWhole(path, "9\n8\n7\n6\n");
  expect(read()).toEqual([9, 8, 7, 6]);
  appendFileSync(path, "oops\n");
  expect(read).toThrow();
  writeWhole(path, "9\n8\n7\n6\n5\n");
  expect(read()).toEqual([9, 8, 7, 6, 5]);
});

test("a kept read is read again only once its file changed; a line count counts blanks, not a partial line", () => {
  const path = join(mkdtempSync(join(tmpdir(), "life-files-")), "f.jsonl");
  let reads = 0;
  const size = keptReader((p) => {
    reads += 1;
    return existsSync(p) ? readFileSync(p).length : 0;
  });
  expect(size(path)).toBe(0);
  writeFileSync(path, "a\n\nb\nc");
  expect(size(path)).toBe(6);
  expect(size(path)).toBe(6);
  expect(reads).toBe(2);
  expect(readLineCount(path)).toBe(3);
  appendFileSync(path, "\n");
  expect(size(path)).toBe(7);
  expect(reads).toBe(3);
  expect(readLineCount(path)).toBe(4);
});

/** node:fs as a module, so a test can spy on what core/files.ts reads. */
const fs = await import("node:fs");
const tempFile = () =>
  join(mkdtempSync(join(tmpdir(), "life-files-")), "f.jsonl");
const page = (path: string, from: number, limit = Number.POSITIVE_INFINITY) =>
  Array.from(readLines(path, from, from + limit));
/** The largest single read `run` makes. */
function largestRead(run: () => void) {
  const spy = spyOn(fs, "readSync");
  try {
    run();
    return Math.max(
      0,
      ...spy.mock.calls.map((c) => Number((c as unknown[])[3]))
    );
  } finally {
    spy.mockRestore();
  }
}

// Regression (life#806): a change read the whole file again and hashed it, and a page of the ledger parsed every line
// before it. A change now reads only the bytes past the last newline read, a block at a time; a page, its own blocks.
test("lines from any line, across the kept blocks, after appends, a partial line and a rewrite", () => {
  const path = tempFile();
  const line = (n: number) =>
    `{"n":${n},"text":"Test line ${"é".repeat(n % 3)}"}`;
  const lines = Array.from({ length: 3000 }, (_, n) => line(n));
  writeFileSync(path, `${lines.join("\n")}\n`);
  // A cold index reads a scan's bytes at a time, never the whole file.
  expect(largestRead(() => expect(readLineCount(path)).toBe(3000))).toBe(
    64 * 1024
  );
  expect(page(path, 0, 2)).toEqual([line(0), line(1)]);
  expect(page(path, 1023, 3)).toEqual([line(1023), line(1024), line(1025)]);
  expect(page(path, 2990)).toEqual(lines.slice(2990));
  expect(page(path, 3000)).toEqual([]);
  // An unaligned line reads its one block.
  const block = Buffer.byteLength(`${lines.slice(1024, 2048).join("\n")}\n`);
  expect(largestRead(() => page(path, 1500, 1))).toBe(block);
  appendFileSync(path, `${line(3000)}\n${line(3001)}`);
  expect(readLineCount(path)).toBe(3001);
  expect(page(path, 2999)).toEqual([line(2999), line(3000)]);
  appendFileSync(path, "\n\n");
  expect(page(path, 3000)).toEqual([line(3000), line(3001), ""]);
  // A large append reads a scan's bytes at a time.
  appendFileSync(path, `${lines.join("\n")}\n`);
  expect(largestRead(() => expect(readLineCount(path)).toBe(6003))).toBe(
    64 * 1024
  );
  writeWhole(path, `${line(7)}\n${line(8)}\n${line(9)}\n`.repeat(1100));
  expect(readLineCount(path)).toBe(3300);
  expect(page(path, 2048, 2)).toEqual([line(9), line(7)]);
});

// Regression (#852's verdict): the rewrite check sampled the first and last 1 KB, so a rewrite that kept them, the
// size and the inode passed as grown: stale rows, and a page starting mid-string. A rewrite is a new file now.
test("a rewrite that keeps the size, the first and the last bytes is read whole again, appended to or not", () => {
  for (const append of [false, true]) {
    const path = tempFile();
    const row = (n: number, text = "000000") => `{"n":${n},"t":"${text}"}`;
    const rows = Array.from({ length: 3000 }, (_, n) => row(n));
    writeFileSync(path, `${rows.join("\n")}\n`);
    const read = () =>
      readAppended(
        path,
        z.object({ n: z.number(), t: z.string() }),
        (last?: string[]) => [...(last ?? [])],
        (all, r) => {
          all.push(r.t);
        }
      );
    expect(read()[1023]).toBe("000000");
    expect(page(path, 1024, 1)).toEqual([row(1024)]);
    rows[1023] = row(1023, "000000999");
    rows[1024] = row(1024, "000");
    writeWhole(path, `${rows.join("\n")}\n`);
    if (append) {
      appendFileSync(path, `${row(3000)}\n`);
    }
    expect(read().slice(1023, 1025)).toEqual(["000000999", "000"]);
    expect(read()).toHaveLength(append ? 3001 : 3000);
    expect(page(path, 1024, 1)).toEqual([row(1024, "000")]);
  }
});

test("a failed read keeps the last result and folds nothing; a retry adds each new row once", () => {
  const path = tempFile();
  let added = 0;
  const read = () =>
    readAppended(
      path,
      z.number(),
      (last?: number[]) => [...(last ?? [])],
      (all, n) => {
        added += 1;
        all.push(n);
      }
    );
  writeFileSync(path, "1\n2\n");
  const first = read();
  appendFileSync(path, "3\n");
  const spy = spyOn(fs, "readSync").mockImplementationOnce(() => {
    throw new Error("EIO");
  });
  expect(read).toThrow("EIO");
  spy.mockRestore();
  expect(first).toEqual([1, 2]);
  expect(added).toBe(2);
  expect(read()).toEqual([1, 2, 3]);
  expect(read()).toEqual([1, 2, 3]);
  expect(added).toBe(3);
});

test("a scan through one descriptor reads the file as it was opened, though it is replaced meanwhile", () => {
  const path = tempFile();
  writeFileSync(path, "a\n".repeat(3000));
  const lines = readLines(path, 0);
  expect(lines.next().value).toBe("a");
  writeWhole(path, "b\n".repeat(3000));
  expect(new Set(lines)).toEqual(new Set(["a"]));
  expect(page(path, 2999)).toEqual(["b"]);
});
