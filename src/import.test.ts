import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linesIn, rowsIn, stage } from "./export";
import { restore } from "./import";
import { DATA } from "./truth";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `life-${name}-`));

/** A test install's export, with an archive of two WhatsApp messages. */
async function exported() {
  const archive = temp("archive");
  const db = new Database(join(archive, "whatsapp.sqlite"));
  db.run("create table messages (id text)");
  db.run("insert into messages values ('a'), ('b')");
  db.close();
  const dir = join(temp("export"), "out");
  await stage(dir, archive);
  return dir;
}

const install = () => ({
  archive: join(temp("to"), "archive"),
  data: join(temp("to"), "data"),
  state: join(temp("to"), "state"),
});

test("an export comes back whole into a new install: the same lines, the same rows", async () => {
  const dir = await exported();
  const to = install();
  const r = await restore(dir, to);
  expect(r.files).toBeGreaterThan(0);
  expect(linesIn(to.data)).toEqual(linesIn(join(dir, "data")));
  expect(rowsIn(join(to.archive, "whatsapp.sqlite"))).toEqual({ messages: 2 });
  expect(Object.keys(linesIn(DATA)).length).toBeGreaterThan(0);
});

test("an import changes nothing when a file is not as exported, his data is there, or the archive holds less", async () => {
  const dir = await exported();
  // A file changed after the export.
  const changed = install();
  const file = readFileSync(join(dir, "manifest.json"), "utf8");
  const one = (JSON.parse(file) as { files: { path: string }[] }).files.find(
    (f) => f.path.endsWith(".jsonl")
  )?.path as string;
  const original = readFileSync(join(dir, one));
  appendFileSync(join(dir, one), "{}\n");
  await expect(restore(dir, changed)).rejects.toThrow("not as exported");
  writeFileSync(join(dir, one), original);
  // His data already there.
  const full = install();
  mkdirSync(full.data, { recursive: true });
  writeFileSync(join(full.data, "x"), "his");
  await expect(restore(dir, full)).rejects.toThrow("not empty");
  // An archive that exists but holds fewer rows: never written to.
  const thin = install();
  mkdirSync(thin.archive, { recursive: true });
  const db = new Database(join(thin.archive, "whatsapp.sqlite"));
  db.run("create table messages (id text)");
  db.run("insert into messages values ('a')");
  db.close();
  await expect(restore(dir, thin)).rejects.toThrow("fewer rows");
  expect(rowsIn(join(thin.archive, "whatsapp.sqlite"))).toEqual({
    messages: 1,
  });
});
