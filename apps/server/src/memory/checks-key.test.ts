import { expect, spyOn, test } from "bun:test";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as voices from "../sources/lifelog-voices";
import { checksAndKeyNow } from "./checks";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as lock from "./memory-lock";

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
