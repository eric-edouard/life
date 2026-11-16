import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { OWNER_DATA_DIR } from "../core/paths";
import { git } from "../core/proc";
import { changeDirectoryEntry } from "./change-directory-entry";

// The run's own copy of the made-up data (OWNER_DATA_DIR): backed up, made a repo, put back.
const TRUTH = join(OWNER_DATA_DIR, "truth");
const BACKUP = `${TRUTH}.backup`;
const file = (p: string) => readFileSync(join(TRUTH, p), "utf8");
const log = () => git(OWNER_DATA_DIR, ["log", "--format=%B"]).stdout.toString();

beforeAll(() => {
  cpSync(TRUTH, BACKUP, { recursive: true });
  git(OWNER_DATA_DIR, ["init", "-q"]);
  git(OWNER_DATA_DIR, ["config", "user.name", "t"]);
  git(OWNER_DATA_DIR, ["config", "user.email", "t@example.test"]);
  git(OWNER_DATA_DIR, ["add", "truth"]);
  git(OWNER_DATA_DIR, ["commit", "-q", "-m", "start"]);
});
afterAll(() => {
  rmSync(join(OWNER_DATA_DIR, ".git"), { force: true, recursive: true });
  rmSync(TRUTH, { force: true, recursive: true });
  cpSync(BACKUP, TRUTH, { recursive: true });
  rmSync(BACKUP, { force: true, recursive: true });
});

const said = "Add it, please.";

test("an invalid change is refused and truth/ is left as it was", async () => {
  const before = file("people.yaml");
  await expect(
    changeDirectoryEntry({
      action: "add",
      area: "nowhere",
      kind: "project",
      name: "Shop",
      said,
    })
  ).rejects.toThrow("unknown area nowhere");
  await expect(
    changeDirectoryEntry({
      action: "add",
      handles: { email: ["owner@example.com"] },
      kind: "person",
      name: "Dup",
      said,
    })
  ).rejects.toThrow("belongs to both");
  await expect(
    changeDirectoryEntry({
      action: "add",
      kind: "goal",
      said,
      text: "Be bold. (`ghost`)",
    })
  ).rejects.toThrow("unknown project ghost");
  expect(file("people.yaml")).toBe(before);
  expect(existsSync(join(TRUTH, "projects", "shop.md"))).toBe(false);
});

test("valid changes are written one entry at a time, commented lines kept, and committed with his words", async () => {
  writeFileSync(join(TRUTH, "people.yaml"), `${file("people.yaml")}# kept\n`);
  await changeDirectoryEntry({
    action: "add",
    kind: "area",
    name: "Work",
    said,
  });
  await changeDirectoryEntry({
    action: "add",
    area: "work",
    kind: "project",
    name: "Shop",
    repos: ["shop"],
    said,
  });
  await changeDirectoryEntry({
    action: "add",
    kind: "person",
    name: "Léa Martin",
    relation: "sister",
    said,
  });
  await changeDirectoryEntry({
    action: "edit",
    handles: { email: ["lea@example.com"] },
    id: "lea-martin",
    kind: "person",
    said,
  });
  await changeDirectoryEntry({
    action: "add",
    kind: "goal",
    said,
    text: "Grow the shop. (`shop`)",
  });
  await changeDirectoryEntry({
    action: "edit",
    kind: "goal",
    number: 1,
    said,
    text: "Be very well.",
  });
  await changeDirectoryEntry({
    action: "edit",
    kind: "may_keep",
    said,
    text: "Nothing about my health.",
  });
  expect(file("areas.yaml")).toContain('{"id":"work","name":"Work"}');
  expect(file("projects/shop.md")).toContain('repos: ["shop"]');
  expect(file("people.yaml")).toContain("# kept");
  expect(file("people.yaml")).toContain("lea@example.com");
  expect(file("me.md")).toContain(
    "1. Be very well.\n2. Grow the shop. (`shop`)"
  );
  expect(file("me.md")).toContain(
    "## What Life may keep\nNothing about my health."
  );
  expect(log()).toContain("Truth, by his words: edit person lea-martin");
  expect(log()).toContain(said);
});

test("refused: a goal over two lines, a heading in the text, a name with no id", async () => {
  const before = file("me.md");
  const text = (t: string, kind: "goal" | "may_keep") =>
    changeDirectoryEntry({ action: "add", kind, said, text: t });
  await expect(text("One.\n2. Two.", "goal")).rejects.toThrow("one line");
  await expect(text("## Goals", "goal")).rejects.toThrow("start with `#`");
  await expect(text("Fine.\n## Goals\nx", "may_keep")).rejects.toThrow(
    "start with `#`"
  );
  await expect(
    changeDirectoryEntry({ action: "add", kind: "area", name: "健康", said })
  ).rejects.toThrow("give an `id`");
  expect(file("me.md")).toBe(before);
});

test("calls at once each land, `$&` in his words stays as written, and a busy git still answers done", async () => {
  await Promise.all(
    ["alpha", "beta", "gamma"].map((name) =>
      changeDirectoryEntry({ action: "add", kind: "area", name, said })
    )
  );
  for (const id of ["alpha", "beta", "gamma"]) {
    expect(file("areas.yaml")).toContain(`"id":"${id}"`);
  }
  await changeDirectoryEntry({
    action: "add",
    kind: "may_keep",
    said,
    text: "Never keep $& or $1.",
  });
  expect(file("me.md")).toContain("Never keep $& or $1.");
  // The night holds git's index: the write stands, the answer is still done, never a failure.
  writeFileSync(join(OWNER_DATA_DIR, ".git", "index.lock"), "");
  try {
    expect(
      await changeDirectoryEntry({
        action: "add",
        kind: "area",
        name: "Delta",
        said,
      })
    ).toStartWith("Done");
  } finally {
    rmSync(join(OWNER_DATA_DIR, ".git", "index.lock"), { force: true });
  }
  expect(file("areas.yaml")).toContain('"id":"delta"');
});
