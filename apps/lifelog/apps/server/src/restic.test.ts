// The daily restic backup (restic.ts) against a fake restic: the calls, Sunday's retention, the
// day's three tries, and what `GET /status` reads.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { resticFor } from "./restic";
import { testConfig, testDb } from "./testing";

let env: ReturnType<typeof testDb>;
let dir: string;
beforeAll(async () => {
  env = testDb();
  // A space, as in "Application Support".
  dir = await mkdtemp(join(tmpdir(), "lifelog restic-"));
  const fake = join(import.meta.dir, "../fixtures/fake-restic.ts");
  await $`${process.execPath} build --compile ${fake} --outfile ${join(dir, "restic")}`.quiet();
  await mkdir(join(dir, "audio/blocks"), { recursive: true });
  await writeFile(join(dir, "audio/blocks/1-a.ogg"), "speech");
});
afterAll(async () => {
  env.drop();
  await rm(dir, { force: true, recursive: true });
});

const calls = async () => {
  const text = await Bun.file(join(dir, "calls"))
    .text()
    .catch(() => "");
  await rm(join(dir, "calls"), { force: true });
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ")[0]);
};

test("without the three settings there is no restic backup", () => {
  expect(
    resticFor(env.db, testConfig("http://x", { RESTIC_REPOSITORY: "/r" }))
  ).toBeNull();
});

test("a snapshot a day, the repository made once, Sunday's forget and check", async () => {
  const restic = resticFor(
    env.db,
    testConfig("http://x", {
      AUDIO_DIR: join(dir, "audio"),
      DATABASE_PATH: join(dir, "archive.sqlite"),
      RESTIC_BINARY: join(dir, "restic"),
      RESTIC_PASSWORD: "hunter2",
      RESTIC_REPOSITORY: join(dir, "repo"),
    })
  );
  if (!restic) {
    throw new Error("restic is set");
  }
  // Readers see it: no repository, no password.
  expect(restic.status()).toEqual({ lastError: null, lastSnapshotAt: null });
  // Monday 19 October 2026, noon.
  const monday = new Date(2026, 9, 19, 12);
  expect(await restic.daily(monday)).toBe(true);
  const log = await Bun.file(join(dir, "calls")).text();
  expect(log).toContain("pw=hunter2");
  expect(log).toContain(
    "backup --quiet --tag daily --host lifelog --ignore-inode --ignore-ctime"
  );
  expect(await calls()).toEqual(["cat", "init", "backup"]);
  expect(existsSync(join(dir, "restic-staging"))).toBe(false);
  expect(restic.status().lastSnapshotAt).not.toBeNull();
  // Taken today: nothing more.
  expect(await restic.daily(monday)).toBe(false);
  expect(await calls()).toEqual([]);

  const sunday = new Date(2026, 9, 25, 12);
  expect(await restic.daily(sunday)).toBe(true);
  expect(await calls()).toEqual(["cat", "backup", "forget", "check"]);

  // A failing day: three tries, then none until tomorrow; the last error is shown.
  await writeFile(join(dir, "fail"), "");
  const next = new Date(2026, 9, 26, 12);
  for (let i = 0; i < 4; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one try after the other
    expect(await restic.daily(next)).toBe(false);
  }
  expect(await calls()).toEqual([
    "cat",
    "backup",
    "cat",
    "backup",
    "cat",
    "backup",
  ]);
  expect(restic.status().lastError).toBe(
    "restic backup: Fatal: repository is locked"
  );

  // An older restic's words for no repository; a snapshot saved without some file.
  await rm(join(dir, "fail"));
  await rm(join(dir, "inited"));
  await writeFile(join(dir, "old"), "");
  await writeFile(join(dir, "partial"), "");
  expect(await restic.daily(new Date(2026, 9, 27, 12))).toBe(true);
  expect(await calls()).toEqual(["cat", "init", "backup"]);
  expect(restic.status().lastError).toBe(
    "restic backup: the snapshot is incomplete, some files could not be read"
  );
});
