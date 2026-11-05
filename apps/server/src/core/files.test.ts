import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readAppended } from "./files";

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
