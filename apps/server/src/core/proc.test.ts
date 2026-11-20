import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeAt, commitPaths, firstLine, gitOut } from "./proc";

test("firstLine: stdin stays open until a whole line passes, then the server is killed; an exit is none", async () => {
  // Answers only after its input, in two writes: a half line must not pass.
  const server = [
    "sh",
    "-c",
    'read x; echo noise; printf "got "; sleep 0.1; echo "$x"; sleep 30',
  ];
  const started = performance.now();
  expect(await firstLine(server, "hello\n", (l) => l.startsWith("got"))).toBe(
    "got hello"
  );
  expect(performance.now() - started).toBeLessThan(5000);
  expect(
    await firstLine(["sh", "-c", "echo noise"], "", (l) => l === "x")
  ).toBeUndefined();
  // Gone before reading its input: no answer, never a crash.
  expect(
    await firstLine(["sh", "-c", "exit 0"], "x".repeat(2e6), () => true)
  ).toBeUndefined();
});

test("a commit to the server's code is new code: the always-on services restart on it", () => {
  const repo = mkdtempSync(join(tmpdir(), "life-code-"));
  const git = (...args: string[]) =>
    gitOut(repo, [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      ...args,
    ]);
  git("init", "-q");
  for (const dir of ["apps/server/src", "prompts", "assets"]) {
    mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, dir, "a.txt"), "1");
  }
  git("add", "-A");
  git("commit", "-qm", "one");
  const before = codeAt(repo);
  writeFileSync(join(repo, "apps/server/src/a.txt"), "2");
  git("commit", "-qam", "two");
  expect(codeAt(repo)).not.toBe(before);
});

test("commitPaths takes each path literally, commits a tracked folder gone whole (removed by hand or by git rm), and leaves what else was staged", () => {
  const repo = mkdtempSync(join(tmpdir(), "life-commit-"));
  gitOut(repo, ["init", "-q"]);
  gitOut(repo, ["config", "user.email", "test@example.test"]);
  gitOut(repo, ["config", "user.name", "Test"]);
  for (const [path, text] of [
    ["project-test-*/AGENTS.md", "Test rules"],
    ["project-test-x/AGENTS.md", "Other rules"],
    ["assignments/asg_test/NOTES.md", "Test notes"],
    ["staged.md", "Test: his"],
    ["assignments/asg_gone/NOTES.md", "Test notes, removed"],
  ] as const) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  gitOut(repo, ["add", "-A"]);
  gitOut(repo, ["commit", "-qm", "start"]);
  writeFileSync(join(repo, "project-test-*/AGENTS.md"), "Test rules, new");
  writeFileSync(join(repo, "project-test-x/AGENTS.md"), "Other rules, new");
  rmSync(join(repo, "assignments/asg_test"), { force: true, recursive: true });
  writeFileSync(join(repo, "staged.md"), "Test: his, staged");
  gitOut(repo, ["add", "staged.md"]);
  // Already removed from the disk and the index: only the last commit has it.
  gitOut(repo, ["rm", "-rq", "assignments/asg_gone"]);
  commitPaths(
    repo,
    [
      "project-test-*",
      "assignments/asg_test",
      "assignments/asg_gone",
      "assignments/asg_none",
    ],
    "test"
  );
  expect(
    gitOut(repo, ["show", "--name-status", "--format="]).split("\n").toSorted()
  ).toEqual([
    "D\tassignments/asg_gone/NOTES.md",
    "D\tassignments/asg_test/NOTES.md",
    "M\tproject-test-*/AGENTS.md",
  ]);
  // His staged file stays staged; the other folder, which the pattern would have matched, stays unstaged.
  expect(gitOut(repo, ["diff", "--cached", "--name-only"])).toBe("staged.md");
  expect(gitOut(repo, ["diff", "--name-only"])).toBe(
    "project-test-x/AGENTS.md"
  );
});
