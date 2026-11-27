import { expect, spyOn, test } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: spied on, so the file can be swapped mid-rotation.
import * as fs from "node:fs";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
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
      "com.ericedouard.life.voice-embedder.log",
      "com.ericedouard.life.bridges.log",
      "life-desk.old.log",
      "other-app.log",
    ]) {
      writeFileSync(join(dir, n), big);
    }
    writeFileSync(join(dir, "life-watch.log"), "small\n");
    symlinkSync(join(dir, "other-app.log"), join(dir, "life-linked.log"));
    // A writer that doesn't append wrote past an earlier truncate: mostly holes.
    const fd = openSync(
      join(dir, "com.ericedouard.life.voice-server.log"),
      "w"
    );
    writeSync(fd, "late\n", 20_000_000);
    closeSync(fd);
    // Its backup can't be written (a stale half-copy that is a folder): logged, its last backup kept, and the others
    // go on.
    writeFileSync(join(dir, "life-archive.old.log"), "kept\n");
    mkdirSync(join(dir, "life-archive.log.rotating", "x"), { recursive: true });
    expect(rotateProcessLogs(dir).toSorted()).toEqual([
      "com.ericedouard.life.bridges.log",
      "com.ericedouard.life.voice-embedder.log",
      "life-desk.log",
    ]);
    const size = (n: string) => statSync(join(dir, n)).size;
    expect(size("life-desk.log")).toBe(0);
    expect(size("com.ericedouard.life.voice-embedder.old.log")).toBe(
      big.length
    );
    expect(size("com.ericedouard.life.bridges.old.log")).toBe(big.length);
    expect(size("life-archive.log")).toBe(big.length);
    expect(size("life-archive.old.log")).toBe(5);
    expect(size("life-watch.log")).toBe(6);
    expect(size("other-app.log")).toBe(big.length);
    expect(readdirSync(dir)).not.toContain("life-desk.old.old.log");
    expect(readdirSync(dir)).not.toContain("life-linked.old.log");
    expect(size("com.ericedouard.life.voice-server.log")).toBe(20_000_005);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a log put in place of the one being rotated is never emptied: the copy and the truncate hold the one checked", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-logs-"));
  const path = join(dir, "life-desk.log");
  writeFileSync(path, Buffer.alloc(10_000_001, "x"));
  const rm = fs.rmSync;
  // Its writer replaces the file once it is open for rotation.
  const swap = spyOn(fs, "rmSync").mockImplementation((p, o) => {
    renameSync(path, join(dir, "moved"));
    writeFileSync(path, "new\n");
    rm(p, o);
  });
  try {
    expect(rotateProcessLogs(dir)).toEqual(["life-desk.log"]);
    expect(readFileSync(path, "utf8")).toBe("new\n");
    expect(statSync(join(dir, "moved")).size).toBe(0);
    expect(statSync(join(dir, "life-desk.old.log")).size).toBe(10_000_001);
    // Owner-only, whatever the umask.
    expect(statSync(join(dir, "life-desk.old.log")).mode.toString(8)).toEndWith(
      "600"
    );
  } finally {
    swap.mockRestore();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("a backup is whole even when the disk takes a write in parts", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-logs-"));
  const big = Buffer.alloc(10_000_001, "y");
  writeFileSync(join(dir, "life-desk.log"), big);
  const write = fs.writeSync;
  const short = spyOn(fs, "writeSync").mockImplementation(((
    fd: number,
    b: NodeJS.ArrayBufferView,
    off: number,
    n: number
  ) => write(fd, b, off, Math.min(n, 4096))) as typeof fs.writeSync);
  try {
    expect(rotateProcessLogs(dir)).toEqual(["life-desk.log"]);
    expect(readFileSync(join(dir, "life-desk.old.log")).equals(big)).toBe(true);
  } finally {
    short.mockRestore();
    rmSync(dir, { force: true, recursive: true });
  }
});
