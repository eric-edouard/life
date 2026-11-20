// The trees `bun run check` passed on, kept under the git common dir so every worktree shares them: a push whose clean
// tree already passed runs only the steps that read data outside the tree (the pre-push hook).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitOut } from "@life/server/src/core/proc";

const KEPT = 50;

/** HEAD's tree when the working tree is clean (untracked files count as changes); null otherwise. */
export const readCleanTree = (cwd: string) =>
  gitOut(cwd, ["status", "--porcelain", "--untracked-files=normal"]) === ""
    ? gitOut(cwd, ["rev-parse", "HEAD^{tree}"])
    : null;

const passedFile = (cwd: string) =>
  join(
    gitOut(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    "life-check-passed"
  );

function readPassed(cwd: string) {
  try {
    return readFileSync(passedFile(cwd), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// An entry is a tree, with " swift" when the phone's and the helper's builds ran on it too.
const entryOf = (tree: string, swift: boolean) =>
  swift ? `${tree} swift` : tree;

/** Whether `tree` passed, with the Swift builds when `swift` says they are due now. */
export function hasPassed(cwd: string, tree: string, swift: boolean) {
  const kept = readPassed(cwd);
  return (
    kept.includes(entryOf(tree, true)) ||
    (!swift && kept.includes(entryOf(tree, false)))
  );
}

/** Records a passed tree, keeping the last `KEPT`. The check's Mac-wide lock serializes writers. */
export function recordPassed(cwd: string, tree: string, swift: boolean) {
  const entry = entryOf(tree, swift);
  const kept = [...readPassed(cwd).filter((e) => e !== entry), entry];
  writeFileSync(passedFile(cwd), `${kept.slice(-KEPT).join("\n")}\n`);
}
