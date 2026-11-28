import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { writeJson } from "../core/files";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as voices from "../sources/voice-speakers";
import { checksAndKeyNow } from "./checks";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as lock from "./memory-lock";
import { projectSituationPath } from "./situation-parts";

// The checks' key versions the connector's reads: the same files, the same key; while a run holds the lock the list is
// read again on every call (a unit may change a card under the same files' stamp), so its key is never given twice.

test("the checks' key holds while nothing changed, and is never the same twice while a run holds the lock", async () => {
  const queue = spyOn(voices, "readNamingQueue").mockResolvedValue([]);
  const locked = spyOn(lock, "isLocked").mockReturnValue(false);
  try {
    const { key } = await checksAndKeyNow(null);
    expect((await checksAndKeyNow(null)).key).toBe(key);
    locked.mockReturnValue(true);
    const first = (await checksAndKeyNow(null)).key;
    expect((await checksAndKeyNow(null)).key).not.toBe(first);
  } finally {
    queue.mockRestore();
    locked.mockRestore();
  }
});

// A project head's answer (`read_matters` of a project) is kept under this key: its situation is a file of its own, so
// one written, or rebuilt, gives a new key and an `ifNot` read never answers `unchanged` with the old one.
test("the checks' key moves when a project's situation is written", async () => {
  const queue = spyOn(voices, "readNamingQueue").mockResolvedValue([]);
  const locked = spyOn(lock, "isLocked").mockReturnValue(false);
  const path = projectSituationPath("test-key-project");
  try {
    const { key } = await checksAndKeyNow(null);
    writeJson(path, { lines: [] });
    const written = (await checksAndKeyNow(null)).key;
    expect(written).not.toBe(key);
    writeJson(path, { lines: [{ cites: ["obs_a"], text: "Moved on." }] });
    expect((await checksAndKeyNow(null)).key).not.toBe(written);
  } finally {
    rmSync(path, { force: true });
    queue.mockRestore();
    locked.mockRestore();
  }
});
