import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeAt, firstLine, gitOut } from "./proc";

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
