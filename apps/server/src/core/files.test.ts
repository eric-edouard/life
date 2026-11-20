import { expect, test } from "bun:test";
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
  readLinesFrom,
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
  writeFileSync(path, "9\n8\n7\n6\n");
  expect(read()).toEqual([9, 8, 7, 6]);
  appendFileSync(path, "oops\n");
  expect(read).toThrow();
  writeFileSync(path, "9\n8\n7\n6\n5\n");
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

// Regression (life#806): a change read the whole file again and hashed it, and a page of the ledger parsed every line
// before it. A change now reads only the bytes past the last newline read; a page, only its own lines.
test("a page of lines from any line, across the kept steps, after appends, a partial line and a rewrite", () => {
  const path = join(mkdtempSync(join(tmpdir(), "life-files-")), "f.jsonl");
  const line = (n: number) =>
    `{"n":${n},"text":"Test line ${"é".repeat(n % 3)}"}`;
  const lines = Array.from({ length: 3000 }, (_, n) => line(n));
  writeFileSync(path, `${lines.join("\n")}\n`);
  expect(readLineCount(path)).toBe(3000);
  expect(readLinesFrom(path, 0, 2)).toEqual([line(0), line(1)]);
  expect(readLinesFrom(path, 1023, 3)).toEqual([
    line(1023),
    line(1024),
    line(1025),
  ]);
  expect(readLinesFrom(path, 2990)).toEqual(lines.slice(2990));
  expect(readLinesFrom(path, 3000)).toEqual([]);
  appendFileSync(path, `${line(3000)}\n${line(3001)}`);
  expect(readLineCount(path)).toBe(3001);
  expect(readLinesFrom(path, 2999)).toEqual([line(2999), line(3000)]);
  appendFileSync(path, "\n\n");
  expect(readLinesFrom(path, 3000)).toEqual([line(3000), line(3001), ""]);
  // A rewrite in place (another last line): read whole again.
  writeFileSync(path, `${line(7)}\n${line(8)}\n${line(9)}\n`.repeat(1100));
  expect(readLineCount(path)).toBe(3300);
  expect(readLinesFrom(path, 2048, 2)).toEqual([line(9), line(7)]);
});
