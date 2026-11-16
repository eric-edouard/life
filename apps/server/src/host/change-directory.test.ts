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
import { changeDirectory } from "./change-directory";

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
    changeDirectory({
      action: "add",
      area: "nowhere",
      kind: "project",
      name: "Shop",
      said,
    })
  ).rejects.toThrow("unknown area nowhere");
  await expect(
    changeDirectory({
      action: "add",
      handles: { email: ["owner@example.com"] },
      kind: "person",
      name: "Dup",
      said,
    })
  ).rejects.toThrow("belongs to both");
  await expect(
    changeDirectory({
      action: "add",
      kind: "goal",
      said,
      text: "Win. (`ghost`)",
    })
  ).rejects.toThrow("unknown project ghost");
  expect(file("people.yaml")).toBe(before);
  expect(existsSync(join(TRUTH, "projects", "shop.md"))).toBe(false);
});

test("valid changes are written one entry at a time, commented lines kept, and committed with his words", async () => {
  writeFileSync(join(TRUTH, "people.yaml"), `${file("people.yaml")}# kept\n`);
  await changeDirectory({ action: "add", kind: "area", name: "Work", said });
  await changeDirectory({
    action: "add",
    area: "work",
    kind: "project",
    name: "Shop",
    repos: ["shop"],
    said,
  });
  await changeDirectory({
    action: "add",
    kind: "person",
    name: "Léa Martin",
    relation: "sister",
    said,
  });
  await changeDirectory({
    action: "edit",
    handles: { email: ["lea@example.com"] },
    id: "lea-martin",
    kind: "person",
    said,
  });
  await changeDirectory({
    action: "add",
    kind: "goal",
    said,
    text: "Grow the shop. (`shop`)",
  });
  await changeDirectory({
    action: "edit",
    kind: "goal",
    number: 1,
    said,
    text: "Be very well.",
  });
  await changeDirectory({
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
