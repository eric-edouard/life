import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdArchive, MIGRATIONS } from "@lifelog/db";
import type { Dictation } from "@lifelog/db/schema";
import { idle } from "./dictation";
import { vouchedThrough } from "./mac-socket";
import { macView } from "./quiet-ranges";

test("a second server on the same archive stops before it touches it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lifelog-lock-"));
  try {
    const file = join(dir, "archive.sqlite");
    const first = holdArchive(file);
    expect(() => holdArchive(file)).toThrow("another server holds");
    first.close();
    holdArchive(file).close();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// Runs the committed migrations up to the one named (from the one after `after`), on a bare SQLite file.
const runUpTo = async (sqlite: Database, upTo: string, after?: string) => {
  const files = (await readdir(MIGRATIONS))
    .filter((f) => f.endsWith(".sql"))
    .toSorted();
  const from = after ? files.indexOf(`${after}.sql`) + 1 : 0;
  for (const file of files.slice(from, files.indexOf(`${upTo}.sql`) + 1)) {
    // biome-ignore lint/performance/noAwaitInLoops: in order
    const text = await Bun.file(join(MIGRATIONS, file)).text();
    for (const statement of text.split("--> statement-breakpoint")) {
      sqlite.run(statement);
    }
  }
};

test("the cutover from the helper's protocol 1 keeps a held watermark and a sleeping Mac", async () => {
  const sqlite = new Database(":memory:");
  await runUpTo(sqlite, "20261022115421_raw_pages");
  // Held: a dictation under way 30 s before the Mac was last heard, asleep then.
  sqlite.run(
    "insert into mac_watch (asleep, heard_at, id, watched_through) values (1, 100000, 1, 70000)"
  );
  await runUpTo(
    sqlite,
    "20261022145553_mac_watch_state",
    "20261022115421_raw_pages"
  );
  const row = sqlite.query("select heard_at, state from mac_watch").get() as {
    heard_at: number;
    state: string;
  };
  const state = JSON.parse(row.state) as Dictation;
  expect(state).toEqual({ ...idle, asleep: true, blockedSince: 70_000 });
  expect(row.heard_at).toBe(100_000);
  // Held, so asleep doesn't free it, nor does silence: the watermark stays at the hold.
  const view = macView({ heardAt: new Date(100_000), state });
  expect(view).toMatchObject({
    asleep: false,
    watchedThrough: new Date(70_000).toISOString(),
  });
  expect(
    vouchedThrough(view, new Date(100_000 + 10 * 3_600_000)).getTime()
  ).toBe(70_000);
  // Nothing held: no block.
  const clear = new Database(":memory:");
  await runUpTo(clear, "20261022115421_raw_pages");
  clear.run(
    "insert into mac_watch (asleep, heard_at, id, watched_through) values (0, 100000, 1, 100000)"
  );
  await runUpTo(
    clear,
    "20261022145553_mac_watch_state",
    "20261022115421_raw_pages"
  );
  const after = clear.query("select state from mac_watch").get() as {
    state: string;
  };
  expect(JSON.parse(after.state)).toEqual(idle);
});
