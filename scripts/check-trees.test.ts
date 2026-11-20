import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasPassed, readCleanTree, recordPassed } from "./check-trees";

const SHA = /^[0-9a-f]{40}$/;

test("a clean tree that passed is known to every worktree; a dirty one never is", async () => {
  const repo = mkdtempSync(join(tmpdir(), "check-trees-"));
  const $ = (cmd: string[], cwd = repo) => Bun.$`git ${cmd}`.cwd(cwd).quiet();
  await $(["init", "-q"]);
  writeFileSync(join(repo, "a.txt"), "a");
  await $(["add", "."]);
  await $(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a"]);

  const tree = await readCleanTree(repo);
  expect(tree).toMatch(SHA);
  expect(await hasPassed(repo, tree as string)).toBe(false);
  await recordPassed(repo, tree as string);
  expect(await hasPassed(repo, tree as string)).toBe(true);

  const other = join(repo, "..", `${repo.split("/").at(-1)}-wt`);
  await $(["worktree", "add", "-q", other]);
  expect(await readCleanTree(other)).toBe(tree);
  expect(await hasPassed(other, tree as string)).toBe(true);

  writeFileSync(join(repo, "b.txt"), "b");
  expect(await readCleanTree(repo)).toBeNull();

  for (const i of Array.from({ length: 60 }, (_, n) => n)) {
    // biome-ignore lint/performance/noAwaitInLoops: the list's order is the test
    await recordPassed(repo, `t${i}`);
  }
  expect(await hasPassed(repo, tree as string)).toBe(false);
  expect(await hasPassed(repo, "t59")).toBe(true);
  expect(await hasPassed(repo, "t9")).toBe(false);
  expect(await hasPassed(repo, "t10")).toBe(true);
});
