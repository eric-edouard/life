import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOut } from "@life/server/src/core/proc";
import { hasPassed, readCleanTree, recordPassed } from "./check-trees";

const parent = mkdtempSync(join(tmpdir(), "check-trees-"));
afterAll(() => rmSync(parent, { force: true, recursive: true }));

test("a clean tree that passed is known to every worktree; a dirty one never is", () => {
  const repo = join(parent, "repo");
  gitOut(parent, ["init", "-q", repo]);
  gitOut(repo, ["config", "user.email", "test@example.test"]);
  gitOut(repo, ["config", "user.name", "Test"]);
  // Untracked files count even when status would hide them.
  gitOut(repo, ["config", "status.showUntrackedFiles", "no"]);
  writeFileSync(join(repo, "a.txt"), "a");
  gitOut(repo, ["add", "."]);
  gitOut(repo, ["commit", "-qm", "a"]);

  const tree = readCleanTree(repo) as string;
  expect(tree).toBe(gitOut(repo, ["rev-parse", "HEAD^{tree}"]));
  expect(hasPassed(repo, tree, false)).toBe(false);
  recordPassed(repo, tree, false);
  expect(hasPassed(repo, tree, false)).toBe(true);
  // A pass without the Swift builds does not cover a push that needs them; one with them covers both.
  expect(hasPassed(repo, tree, true)).toBe(false);
  recordPassed(repo, tree, true);
  expect(hasPassed(repo, tree, true)).toBe(true);
  recordPassed(repo, tree, false);
  expect(hasPassed(repo, tree, true)).toBe(true);

  const other = join(parent, "other");
  gitOut(repo, ["worktree", "add", "-q", other]);
  expect(readCleanTree(other)).toBe(tree);
  expect(hasPassed(other, tree, true)).toBe(true);

  writeFileSync(join(repo, "b.txt"), "b");
  expect(readCleanTree(repo)).toBeNull();

  for (const i of Array.from({ length: 60 }, (_, n) => n)) {
    recordPassed(repo, `t${i}`, false);
  }
  expect(hasPassed(repo, tree, false)).toBe(false);
  expect(hasPassed(repo, "t59", false)).toBe(true);
  expect(hasPassed(repo, "t9", false)).toBe(false);
  expect(hasPassed(repo, "t10", false)).toBe(true);
  // Each tree holds one entry: 50 trees, not 50 lines.
  recordPassed(repo, "t10", true);
  expect(hasPassed(repo, "t11", false)).toBe(true);
});
