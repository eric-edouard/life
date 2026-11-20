// The trees `bun run check` passed on, kept under the git common dir so every worktree shares them: a push whose clean
// tree already passed skips the check (the pre-push hook).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEPT = 50;

/** HEAD's tree when the working tree is clean (untracked files count as changes); null otherwise. */
export async function readCleanTree(cwd: string) {
  const status = await Bun.$`git status --porcelain`.cwd(cwd).quiet().text();
  return status.trim() === ""
    ? (await Bun.$`git rev-parse HEAD^{tree}`.cwd(cwd).quiet().text()).trim()
    : null;
}

const passedFile = async (cwd: string) =>
  join(
    (
      await Bun.$`git rev-parse --path-format=absolute --git-common-dir`
        .cwd(cwd)
        .quiet()
        .text()
    ).trim(),
    "life-check-passed"
  );

async function readPassed(cwd: string) {
  try {
    return readFileSync(await passedFile(cwd), "utf8")
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

export const hasPassed = async (cwd: string, tree: string) =>
  (await readPassed(cwd)).includes(tree);

/** Records a passed tree, keeping the last `KEPT`. The check's Mac-wide lock serializes writers. */
export async function recordPassed(cwd: string, tree: string) {
  const trees = [...(await readPassed(cwd)).filter((t) => t !== tree), tree];
  writeFileSync(await passedFile(cwd), `${trees.slice(-KEPT).join("\n")}\n`);
}
