// The archive as a folder and back (export.ts): a round trip, and every refusal leaving nothing.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDER_DIMENSIONS } from "@life/server/src/core/embedder";
import { connect, countRows, holdArchive } from "@lifelog/db";
import { conversations, searchPassages } from "@lifelog/db/schema";
import { eq, sql } from "drizzle-orm";
import { exportArchive, importArchive, runCommand } from "./export";
import { testDb } from "./testing";

let env: ReturnType<typeof testDb>;
let dir: string;
beforeAll(async () => {
  env = testDb();
  dir = await mkdtemp(join(tmpdir(), "lifelog-export-"));
  const now = Date.now();
  env.db
    .insert(conversations)
    .values({
      captureEndedAt: new Date(now),
      captureStartedAt: new Date(now - 60_000),
      id: randomUUID(),
    })
    .run();
  // A gap in the passages' rowids, which a vacuum may close.
  const passage = (text: string) => ({
    conversationId: randomUUID(),
    embedding: Array.from({ length: EMBEDDER_DIMENSIONS }, () => 0),
    firstTurn: 0,
    jobId: randomUUID(),
    languageCode: "eng",
    lastTurn: 0,
    model: "m",
    personIds: [],
    speakers: [],
    text,
    textHash: text,
  });
  env.db
    .insert(searchPassages)
    .values([passage("Monday at nine."), passage("Tuesday at ten.")])
    .run();
  env.db
    .delete(searchPassages)
    .where(eq(searchPassages.textHash, "Monday at nine."))
    .run();
  const audio = join(dir, "audio");
  await mkdir(join(audio, "blocks/s"), { recursive: true });
  await mkdir(join(audio, "archive"), { recursive: true });
  await writeFile(join(audio, "blocks/s/1-a.ogg"), "speech");
  await writeFile(join(audio, "blocks/s/2-b.ogg.x.part"), "half");
  await writeFile(join(audio, "archive/2026-10-01-c.sqlite"), "old copy");
});
afterAll(async () => {
  env.drop();
  await rm(dir, { force: true, recursive: true });
});

const exported = async () => {
  const folder = join(dir, `export-${randomUUID()}`);
  return {
    folder,
    totals: await exportArchive(env.db, join(dir, "audio"), folder),
  };
};
const target = () => {
  const at = join(dir, `install-${randomUUID()}`);
  return { audio: join(at, "audio"), db: join(at, "archive.sqlite") };
};

test("an export goes back into a new install whole: archive, audio, keyword index", async () => {
  const { folder, totals } = await exported();
  const manifest = await Bun.file(join(folder, "manifest.json")).json();
  expect(Object.keys(manifest.files).sort()).toEqual([
    "archive.sqlite",
    "audio/blocks/s/1-a.ogg",
  ]);
  expect(manifest).toMatchObject({ app: "lifelog", format: 1 });
  expect(manifest.counts.conversations).toBe(1);
  expect(totals.files).toBe(2);
  // Refused over anything there.
  await expect(
    exportArchive(env.db, join(dir, "audio"), folder)
  ).rejects.toThrow("is not empty");

  const to = target();
  expect(await importArchive(folder, to.db, to.audio)).toEqual(totals);
  expect(await readdir(join(to.audio, "blocks/s"))).toEqual(["1-a.ogg"]);
  const db = connect(to.db, { readonly: true });
  expect(countRows(db, conversations)).toBe(1);
  // Keyword search finds the passages it holds (search_text follows them by rowid).
  expect(
    db.all<{ text: string }>(
      sql`select text from search_passages where rowid in
        (select rowid from search_text where search_text match 'Tuesday')`
    )
  ).toEqual([{ text: "Tuesday at ten." }]);
  db.$client.close(true);
  expect(existsSync(`${to.db}.importing`)).toBe(false);

  // A second import over it is refused, and so is audio already there.
  await expect(importArchive(folder, to.db, to.audio)).rejects.toThrow(
    "holds an archive already: nothing was changed"
  );
  const other = target();
  await mkdir(other.audio, { recursive: true });
  await writeFile(join(other.audio, "x.ogg"), "x");
  await expect(importArchive(folder, other.db, other.audio)).rejects.toThrow(
    "holds audio already"
  );
  expect(existsSync(other.db)).toBe(false);
});

test("an import that crashed between its renames runs again over its own audio", async () => {
  const { folder } = await exported();
  const to = target();
  await importArchive(folder, to.db, to.audio);
  // The audio moved in, the archive never did.
  await rm(to.db);
  expect(await importArchive(folder, to.db, to.audio)).toMatchObject({
    files: 2,
  });
  expect(await readdir(join(to.audio, "blocks/s"))).toEqual(["1-a.ogg"]);
  // Audio that isn't the export's is refused.
  await rm(to.db);
  await writeFile(join(to.audio, "blocks/s/1-a.ogg"), "other");
  await expect(importArchive(folder, to.db, to.audio)).rejects.toThrow(
    "holds audio already"
  );
});

test("an archive short of the rows the manifest counted is refused", async () => {
  const { folder } = await exported();
  const path = join(folder, "manifest.json");
  const manifest = await Bun.file(path).json();
  manifest.counts.conversations = 2;
  await writeFile(path, JSON.stringify(manifest));
  const to = target();
  await expect(importArchive(folder, to.db, to.audio)).rejects.toThrow(
    "archive.sqlite is not as counted (conversations): nothing was changed"
  );
  expect(existsSync(to.db)).toBe(false);
  expect(existsSync(to.audio)).toBe(false);
});

test("a changed file is refused before anything is written", async () => {
  const { folder } = await exported();
  await writeFile(join(folder, "audio/blocks/s/1-a.ogg"), "spEech");
  const to = target();
  await expect(importArchive(folder, to.db, to.audio)).rejects.toThrow(
    "audio/blocks/s/1-a.ogg is not as exported: nothing was changed"
  );
  expect(existsSync(to.db)).toBe(false);
  expect(existsSync(to.audio)).toBe(false);
  expect(existsSync(`${to.audio}.importing`)).toBe(false);
});

test("an import waits for the server to stop; the command answers one JSON line", async () => {
  const { folder } = await exported();
  const to = target();
  await mkdir(join(to.db, ".."), { recursive: true });
  const lock = holdArchive(to.db);
  await expect(importArchive(folder, to.db, to.audio)).rejects.toThrow(
    "another server holds"
  );
  lock.close();
  const lines: string[] = [];
  const { log } = console;
  console.log = (line: string) => lines.push(line);
  try {
    const vars = { AUDIO_DIR: to.audio, DATABASE_PATH: to.db };
    expect(await runCommand(["import", folder], vars)).toBe(0);
    expect(await runCommand(["import", folder], vars)).toBe(1);
  } finally {
    console.log = log;
  }
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({ files: 2, ok: true });
  expect(JSON.parse(lines[1] ?? "")).toMatchObject({ ok: false });
});
