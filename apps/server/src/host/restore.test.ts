import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Of } from "../core/hash";
import {
  DESK_STORE,
  OWNER_DATA_DIR,
  PROJECT_WORK_FOLDERS,
} from "../core/paths";
import { gitOut } from "../core/proc";
import { linesIn, rowsIn, stage } from "./export";
import { started } from "./init";
import { putNotes, restore } from "./restore";

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
  expect(Object.keys(linesIn(OWNER_DATA_DIR)).length).toBeGreaterThan(0);
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

/** An export holding one desk assignment's notes, kept in a test agents folder outside Life's state, and their path. */
async function exportedWithNotes() {
  const agents = temp("agents");
  const notes = join(agents, "assignments", "asg_000000000001", "NOTES.md");
  mkdirSync(dirname(notes), { recursive: true });
  writeFileSync(notes, "Test notes: waiting on Ana");
  mkdirSync(dirname(DESK_STORE), { recursive: true });
  const db = new Database(DESK_STORE, { create: true });
  // Only the columns the export reads of the desk's store.
  db.run("create table assignment (id text, notes_path text)");
  db.run("insert into assignment values ('asg_000000000001', ?)", [notes]);
  db.close();
  let dir = "";
  try {
    dir = await exported();
  } finally {
    rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  }
  return { agents, dir, notes };
}

test("a desk assignment's notes kept outside Life's state travel with the export and come back where its store says, the agents folder gone", async () => {
  const { agents, dir, notes } = await exportedWithNotes();
  rmSync(agents, { force: true, recursive: true });
  await restore(dir, install());
  expect(readFileSync(notes, "utf8")).toBe("Test notes: waiting on Ana");
});

test("an import over other notes at a notes file's place changes nothing; the same notes there pass", async () => {
  const { dir, notes } = await exportedWithNotes();
  writeFileSync(notes, "Older test notes");
  const to = install();
  await expect(restore(dir, to)).rejects.toThrow("holds other notes");
  expect(readFileSync(notes, "utf8")).toBe("Older test notes");
  expect(existsSync(to.data) || existsSync(to.state)).toBe(false);
  writeFileSync(notes, "Test notes: waiting on Ana");
  await restore(dir, to);
  expect(readFileSync(notes, "utf8")).toBe("Test notes: waiting on Ana");
});

// Verdict on PR 831: notes were placed after a check made before the whole export was hashed; a note written there
// meanwhile was overwritten. Each note is made only where nothing is.
test("a note another writer puts in place after the check is kept, and the notes this import made are taken back", async () => {
  const at = temp("race");
  const ours = join(at, "ours.md");
  writeFileSync(ours, "Test notes: ours");
  const sha256 = await sha256Of(ours);
  const first = join(at, "agents", "asg_1", "NOTES.md");
  const second = join(at, "agents", "asg_2", "NOTES.md");
  mkdirSync(dirname(second), { recursive: true });
  writeFileSync(second, "Test notes: written meanwhile");
  await expect(
    putNotes([
      { from: ours, sha256, to: first },
      { from: ours, sha256, to: second },
    ])
  ).rejects.toThrow("holds other notes");
  expect(readFileSync(second, "utf8")).toBe("Test notes: written meanwhile");
  expect(existsSync(first)).toBe(false);
  // The same bytes there pass, kept as they are.
  writeFileSync(second, "Test notes: ours");
  await putNotes([
    { from: ours, sha256, to: first },
    { from: ours, sha256, to: second },
  ]);
  expect(readFileSync(first, "utf8")).toBe("Test notes: ours");
});

// Confirm on PR 831: the rollback took back a note by its path, someone's edit with it, and a failure other than a
// conflict (a folder it could not make) left the notes made before it.
test("a failed note placement takes back only the notes it made that still hold its bytes, whatever failed", async () => {
  const at = temp("rollback");
  const ours = join(at, "ours.md");
  writeFileSync(ours, "Test notes: ours");
  const sha256 = await sha256Of(ours);
  const note = (asg: string) => join(at, "agents", asg, "NOTES.md");
  // A folder it cannot make: a file stands where it would be.
  writeFileSync(join(at, "agents-file"), "");
  await expect(
    putNotes([
      { from: ours, sha256, to: note("asg_1") },
      { from: ours, sha256, to: join(at, "agents-file", "NOTES.md") },
    ])
  ).rejects.toThrow();
  expect(existsSync(note("asg_1"))).toBe(false);
  // The first note edited by someone while the second is checked: the edit stays.
  mkdirSync(dirname(note("asg_3")), { recursive: true });
  writeFileSync(note("asg_3"), "Test notes: another writer's");
  const hash = await import("../core/hash");
  const real = hash.sha256Of;
  const spy = spyOn(hash, "sha256Of").mockImplementationOnce((p) => {
    writeFileSync(note("asg_2"), "Test notes: edited meanwhile");
    return real(p);
  });
  try {
    await expect(
      putNotes([
        { from: ours, sha256, to: note("asg_2") },
        { from: ours, sha256, to: note("asg_3") },
      ])
    ).rejects.toThrow("holds other notes");
  } finally {
    spy.mockRestore();
  }
  expect(readFileSync(note("asg_2"), "utf8")).toBe(
    "Test notes: edited meanwhile"
  );
  expect(readFileSync(note("asg_3"), "utf8")).toBe(
    "Test notes: another writer's"
  );
});

test("a project's files come back, never over another file of the same place, and nothing is installed or run", async () => {
  const project = join(PROJECT_WORK_FOLDERS, "bakery-page");
  mkdirSync(join(project, "node_modules"), { recursive: true });
  writeFileSync(join(project, "PLAN.md"), "plan");
  gitOut(project, ["init", "-q", "-b", "trunk"]);
  gitOut(project, ["add", "PLAN.md"]);
  gitOut(project, [
    "-c",
    "user.name=a",
    "-c",
    "user.email=a@b.c",
    "commit",
    "-qm",
    "one",
  ]);
  writeFileSync(
    join(project, "package.json"),
    '{"scripts":{"postinstall":"touch ran"}}'
  );
  const dir = await exported();
  rmSync(PROJECT_WORK_FOLDERS, { force: true, recursive: true });
  const other = install();
  mkdirSync(join(other.state, "projects", "bakery-page"), { recursive: true });
  writeFileSync(join(other.state, "projects", "bakery-page", "PLAN.md"), "x");
  await expect(restore(dir, other)).rejects.toThrow("holds another file");
  const to = install();
  await restore(dir, to);
  const back = join(to.state, "projects", "bakery-page");
  expect(readFileSync(join(back, "PLAN.md"), "utf8")).toBe("plan");
  expect(existsSync(join(back, "ran"))).toBe(false);
  // Its history is back: the same branch and commit, no bundle left.
  expect(gitOut(back, ["log", "--format=%s"])).toBe("one");
  expect(gitOut(back, ["branch", "--show-current"])).toBe("trunk");
  // Uncommitted work stays uncommitted.
  expect(gitOut(back, ["status", "--porcelain"])).toBe("?? package.json");
  expect(existsSync(join(back, "history.bundle"))).toBe(false);
});
