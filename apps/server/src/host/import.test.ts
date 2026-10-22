import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA } from "../core/paths";
import { linesIn, rowsIn, stage } from "./export";
import { restore } from "./import";
import { started } from "./init";

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

test("an import that fails partway leaves nothing: no data, no half-made install, nothing beside it", async () => {
  const dir = await exported();
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    files: { path: string }[];
  };
  // The last file listed is changed: everything before it was checked and copied aside.
  const last = m.files.at(-1)?.path as string;
  appendFileSync(join(dir, last), "x");
  const to = install();
  await expect(restore(dir, to)).rejects.toThrow("not as exported");
  expect(started(to.data)).toBe(false);
  for (const p of [
    to.data,
    to.archive,
    `${to.data}.importing`,
    `${to.archive}.importing`,
    `${to.state}.importing`,
  ]) {
    expect(existsSync(p)).toBe(false);
  }
});

test("an archive folder with media but no store is never wiped: the import is refused", async () => {
  const dir = await exported();
  const to = install();
  mkdirSync(join(to.archive, "media"), { recursive: true });
  writeFileSync(join(to.archive, "media", "photo.jpg"), "jpeg");
  await expect(restore(dir, to)).rejects.toThrow("no store");
  expect(readFileSync(join(to.archive, "media", "photo.jpg"), "utf8")).toBe(
    "jpeg"
  );
});

test("an import that stopped while moving in runs again: its own state files left there pass", async () => {
  const dir = await exported();
  const to = install();
  // The settings already moved in by the earlier try, as exported.
  mkdirSync(to.state, { recursive: true });
  copyFileSync(
    join(dir, "state", "settings.json"),
    join(to.state, "settings.json")
  );
  await restore(dir, to);
  expect(started(to.data)).toBe(true);
  // Settings of another install are refused.
  const other = install();
  mkdirSync(other.state, { recursive: true });
  writeFileSync(join(other.state, "settings.json"), "{}");
  await expect(restore(dir, other)).rejects.toThrow("holds an install");
});
