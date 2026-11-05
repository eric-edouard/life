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
import { keptReader, readAppended, readLineCount } from "./files";

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
