import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Of, stage } from "./export";
import { STATE } from "./truth";

const SECRET = /oauth|events\.json|local\.key|\.bak$/;

test("an export holds everything with its checksum and counts, and never a secret", async () => {
  // A secret and a key in Life's state, as a real install has them: never exported.
  mkdirSync(join(STATE, "oauth"), { recursive: true });
  writeFileSync(join(STATE, "oauth", "state.json"), "{}");
  writeFileSync(join(STATE, "events.json"), "{}");
  writeFileSync(join(STATE, "local.key"), "k");
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
