import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Of } from "../core/hash";
import { PROJECT_WORK_FOLDERS } from "../core/paths";
import { SECRETS, writeSecret } from "../core/secret";
import { PASSAGES } from "../memory/memory-files";
import { LOCK } from "../memory/memory-lock";
import { writePassages } from "../memory/passages";
import { DESCRIPTIONS } from "../sources/photo-descriptions";
import { stage, stateInDataOf } from "./export";

const SECRET = /oauth|local\.key|\.bak$/;

test("an export holds everything with its checksum and counts, and never a secret", async () => {
  // A secret and a key in Life's state, as a real install has them: never exported. The test run's own are put back
  // after: other tests read them.
  const before = Object.values(SECRETS).map((p) =>
    existsSync(p) ? readFileSync(p, "utf8") : undefined
  );
  writeSecret("oauth", "{}");
  writeSecret("localKey", "k");
  try {
    const archive = mkdtempSync(join(tmpdir(), "life-archive-"));
    const db = new Database(join(archive, "whatsapp.sqlite"));
    db.run("create table messages (id text)");
    db.run("insert into messages values ('a'), ('b')");
    db.close();
    const phone = new Database(join(archive, "phone.sqlite"));
    phone.run("create table calls (id text)");
    phone.run("insert into calls values ('synthetic-call')");
    phone.close();
    mkdirSync(join(archive, "media"));
    writeFileSync(join(archive, "media", "photo.jpg"), "jpeg");

    writePassages(
      [
        {
          at: "2000-01-01T12:00:00.000Z",
          chat: "export-note",
          fromMe: true,
          id: "export-note",
          sender: "owner",
          source: "notes",
          text: "A made-up note for export",
        },
      ],
      { from: "2000-01-01", to: "2000-01-01" },
      [],
      { notes: () => [] }
    );
    expect(existsSync(PASSAGES)).toBe(true);

    // A one-off project's work folder: what a project made, exported apart from the filters.
    const project = join(PROJECT_WORK_FOLDERS, "bakery-page");
    mkdirSync(join(project, "node_modules"), { recursive: true });
    writeFileSync(join(project, "PLAN.md"), "x");
    writeFileSync(join(project, "result.tmp"), "y");
    writeFileSync(join(project, "notes.sqlite"), "not a database");
    writeFileSync(join(project, ".env.local"), "KEY=made-up");
    writeFileSync(join(project, "node_modules", "pkg.js"), "z");
    symlinkSync(join(project, "PLAN.md"), join(project, "link.md"));

    const dir = join(mkdtempSync(join(tmpdir(), "life-export-")), "out");
    const m = await stage(dir, archive);
    rmSync(PROJECT_WORK_FOLDERS, { force: true, recursive: true });
    const paths = m.files.map((f) => f.path);
    // A project's files, links followed, odd names kept; its secret files and packages left out.
    expect(paths.filter((p) => p.startsWith("state/projects/")).sort()).toEqual(
      ["PLAN.md", "link.md", "notes.sqlite", "result.tmp"].map(
        (f) => `state/projects/bakery-page/${f}`
      )
    );
    expect(paths).toContain("archive/whatsapp.sqlite");
    expect(paths).toContain("archive/phone.sqlite");
    expect(m.counts.rows["archive/phone.sqlite"]).toEqual({ calls: 1 });
    expect(paths).toContain("archive/media/photo.jpg");
    expect(paths.some((p) => p.startsWith("data/"))).toBe(true);
    expect(paths.filter((p) => SECRET.test(p))).toEqual([]);
    expect(
      paths.some((p) => p.startsWith("state/memory/passages.sqlite"))
    ).toBe(false);
    expect(m.counts.rows["state/memory/passages.sqlite"]).toBeUndefined();
    for (const f of m.files.slice(0, 20)) {
      // biome-ignore lint/performance/noAwaitInLoops: a few files
      expect(await sha256Of(join(dir, f.path))).toBe(f.sha256);
    }
    expect(m.counts.rows["archive/whatsapp.sqlite"]).toEqual({ messages: 2 });
    expect(Object.keys(m.counts.lines).length).toBeGreaterThan(0);
    // A folder with something in it is never written into.
    await expect(stage(dir, archive)).rejects.toThrow("not empty");
  } finally {
    Object.values(SECRETS).forEach((p, i) => {
      const text = before[i];
      if (text === undefined) {
        rmSync(p, { force: true });
      } else {
        writeFileSync(p, text);
      }
    });
  }
});

test("an export goes to any folder name, an apostrophe too; it is refused while a run holds memory's lock", async () => {
  const archive = mkdtempSync(join(tmpdir(), "life-archive-"));
  const db = new Database(join(archive, "notes.sqlite"));
  db.run("create table versions (id text)");
  db.close();
  const base = mkdtempSync(join(tmpdir(), "life-export-"));
  const m = await stage(join(base, "Sam's export"), archive);
  expect(m.counts.rows["archive/notes.sqlite"]).toEqual({ versions: 0 });
  writeFileSync(LOCK, String(process.pid));
  try {
    await expect(stage(join(base, "held"), archive)).rejects.toThrow("lock");
  } finally {
    rmSync(LOCK, { force: true });
  }
});

test("a staged file of the last staging's size and mtime keeps its hash; a changed one is hashed again", async () => {
  const archive = mkdtempSync(join(tmpdir(), "life-archive-"));
  mkdirSync(join(archive, "media"));
  writeFileSync(join(archive, "media", "same.jpg"), "jpeg");
  writeFileSync(join(archive, "media", "edited.jpg"), "jpeg");
  const base = mkdtempSync(join(tmpdir(), "life-export-"));
  const first = await stage(join(base, "1"), archive);
  writeFileSync(join(archive, "media", "edited.jpg"), "JPEG");
  const marked = first.files.map((f) => ({ ...f, sha256: `last ${f.path}` }));
  const second = await stage(join(base, "2"), archive, marked);
  const hash = (path: string) =>
    second.files.find((f) => f.path === path)?.sha256;
  expect(hash("archive/media/same.jpg")).toBe("last archive/media/same.jpg");
  expect(hash("archive/media/edited.jpg")).toBe(
    await sha256Of(join(base, "2", "archive/media/edited.jpg"))
  );
});

test("a store in Life's state that is being written, in WAL, is exported whole and counted", async () => {
  mkdirSync(join(DESCRIPTIONS, ".."), { recursive: true });
  const db = new Database(DESCRIPTIONS);
  try {
    db.run("pragma journal_mode = wal");
    db.run("create table if not exists made_up (id text)");
    db.run("delete from made_up");
    db.run("insert into made_up values ('a'), ('b'), ('c')");
    const archive = mkdtempSync(join(tmpdir(), "life-archive-"));
    const dir = join(mkdtempSync(join(tmpdir(), "life-export-")), "out");
    const m = await stage(dir, archive);
    expect(
      m.counts.rows["state/memory/photo-descriptions.sqlite"]
    ).toMatchObject({ made_up: 3 });
    expect(m.files.some((f) => f.path.endsWith("-wal"))).toBe(false);
  } finally {
    db.close();
    rmSync(DESCRIPTIONS, { force: true });
  }
});

// Verdict on PR 831: with Life's state as its data folder, the data's copy (unfiltered) kept the state's secrets. A
// Life of its own (a made-up folder, not a test run's copy) exports from one folder holding a made-up secret.
test("an export whose state is its data folder is refused before anything is staged; a state inside the data is cut out", () => {
  const root = mkdtempSync(join(tmpdir(), "life-one-root-"));
  const out = join(mkdtempSync(join(tmpdir(), "life-one-root-out-")), "export");
  writeFileSync(join(root, ".env"), "TEST_SECRET=made-up\n");
  try {
    const run = Bun.spawnSync(
      ["bun", join(import.meta.dir, "../desk/life-entry.ts"), "export", out],
      {
        env: {
          ...process.env,
          LIFE_MACHINE_DIR: join(root, "machine"),
          LIFE_OWNER_DATA_DIR: root,
          LIFE_STATE_DIR: root,
          NODE_ENV: "production",
        },
      }
    );
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("nothing was staged");
    expect(existsSync(out)).toBe(false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
  expect(stateInDataOf("/test/life", "/test/life/state")).toBe("state");
  expect(stateInDataOf("/test/life", "/test/life/..state")).toBe("..state");
  expect(stateInDataOf("/test/life", "/test/state")).toBeNull();
});
