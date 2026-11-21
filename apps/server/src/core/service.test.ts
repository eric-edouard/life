import { expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateProcessLogs } from "./service";

test("one rotation rule: every process log of Life's past 10 MB is copied to its .old.log and emptied; under it, another name, an .old.log, a link, a file of holes or one that fails is left, and the rest still rotate", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-logs-"));
  try {
    const big = Buffer.alloc(10_000_001, "x");
    for (const n of [
      "life-archive.log",
      "life-desk.log",
      "lifelog-embedder.log",
      "com.ericedouard.life.bridges.log",
      "life-desk.old.log",
      "other-app.log",
    ]) {
      writeFileSync(join(dir, n), big);
    }
    writeFileSync(join(dir, "life-watch.log"), "small\n");
    symlinkSync(join(dir, "other-app.log"), join(dir, "life-linked.log"));
    // A writer that doesn't append wrote past an earlier truncate: mostly holes.
    const fd = openSync(join(dir, "lifelog-server.log"), "w");
    writeSync(fd, "late\n", 20_000_000);
    closeSync(fd);
    // Its copy can't be read: logged, and the others go on.
    chmodSync(join(dir, "life-archive.log"), 0o200);
    expect(rotateProcessLogs(dir).toSorted()).toEqual([
      "com.ericedouard.life.bridges.log",
      "life-desk.log",
      "lifelog-embedder.log",
    ]);
    const size = (n: string) => statSync(join(dir, n)).size;
    expect(size("life-desk.log")).toBe(0);
    expect(size("lifelog-embedder.old.log")).toBe(big.length);
    expect(size("com.ericedouard.life.bridges.old.log")).toBe(big.length);
    expect(size("life-archive.log")).toBe(big.length);
    expect(size("life-watch.log")).toBe(6);
    expect(size("other-app.log")).toBe(big.length);
    expect(readdirSync(dir)).not.toContain("life-desk.old.old.log");
    expect(readdirSync(dir)).not.toContain("life-linked.old.log");
    expect(size("lifelog-server.log")).toBe(20_000_005);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
