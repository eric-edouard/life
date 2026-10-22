import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBSCRIPTION } from "./events";
import { sha256Of, stage } from "./export";
import { LOCK } from "./memory/guard";
import { OAUTH } from "./oauth";
import { LOCAL_KEY } from "./signin";

const SECRET = /oauth|events\.json|local\.key|\.bak$/;

test("an export holds everything with its checksum and counts, and never a secret", async () => {
  // A secret and a key in Life's state, as a real install has them: never exported.
  mkdirSync(OAUTH, { recursive: true });
  writeFileSync(join(OAUTH, "state.json"), "{}");
  writeFileSync(SUBSCRIPTION, "{}");
  writeFileSync(LOCAL_KEY, "k");
  const archive = mkdtempSync(join(tmpdir(), "life-archive-"));
  const db = new Database(join(archive, "whatsapp.sqlite"));
  db.run("create table messages (id text)");
  db.run("insert into messages values ('a'), ('b')");
  db.close();
  mkdirSync(join(archive, "media"));
  writeFileSync(join(archive, "media", "photo.jpg"), "jpeg");

  const dir = join(mkdtempSync(join(tmpdir(), "life-export-")), "out");
  const m = await stage(dir, archive);
  const paths = m.files.map((f) => f.path);
  expect(paths).toContain("archive/whatsapp.sqlite");
  expect(paths).toContain("archive/media/photo.jpg");
  expect(paths.some((p) => p.startsWith("data/"))).toBe(true);
  expect(paths.filter((p) => SECRET.test(p))).toEqual([]);
  for (const f of m.files.slice(0, 20)) {
    // biome-ignore lint/performance/noAwaitInLoops: a few files
    expect(await sha256Of(join(dir, f.path))).toBe(f.sha256);
  }
  expect(m.counts.rows["archive/whatsapp.sqlite"]).toEqual({ messages: 2 });
  expect(Object.keys(m.counts.lines).length).toBeGreaterThan(0);
  // A folder with something in it is never written into.
  await expect(stage(dir, archive)).rejects.toThrow("not empty");
});

test("an export goes to any folder name, an apostrophe too; it is refused while a run holds memory's lock", async () => {
  const archive = mkdtempSync(join(tmpdir(), "life-archive-"));
  const db = new Database(join(archive, "notes.sqlite"));
  db.run("create table versions (id text)");
  db.close();
  const base = mkdtempSync(join(tmpdir(), "life-export-"));
  const m = await stage(join(base, "Sam's export"), archive);
  expect(m.counts.rows["archive/notes.sqlite"]).toEqual({ versions: 0 });
  writeFileSync(LOCK, String(process.ppid));
  try {
    await expect(stage(join(base, "held"), archive)).rejects.toThrow("lock");
  } finally {
    rmSync(LOCK, { force: true });
  }
});
