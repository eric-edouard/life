import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { startStep, TIMED_OUT } from "./run-step";

const STUCK_WORKER = /(\d+) [\d.]+% CPU running .*spin\.test\.ts/;

test("a step past its limit is killed, its test workers too, and the stuck test file is named", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run-step-"));
  const spin = join(dir, "spin.test.ts");
  writeFileSync(
    spin,
    'import { test } from "bun:test";\ntest("spins", () => { for (;;) {} });\n'
  );
  const { result } = startStep(
    [
      process.execPath,
      "test",
      "--parallel=2",
      "--preload",
      join(import.meta.dir, "note-test-file.ts"),
      spin,
    ],
    // Long enough for a worker to start on a loaded Mac.
    10_000,
    join(dir, "running")
  );
  const { code, output } = await result;
  expect(code).toBe(TIMED_OUT);
  expect(output).toContain("stuck: killed after 10 s");
  const worker = output.match(STUCK_WORKER);
  expect(worker).not.toBeNull();
  await Bun.sleep(500);
  expect(() => process.kill(Number(worker?.[1]), 0)).toThrow();
  rmSync(dir, { force: true, recursive: true });
}, 30_000);

test("a step that ends in time gives its exit code and output", async () => {
  const { result } = startStep(
    ["sh", "-c", "echo out; echo err >&2; exit 2"],
    20_000,
    tmpdir()
  );
  expect(await result).toEqual({ code: 2, output: "out\nerr\n" });
});

test("a process a step leaves behind, holding its output open, is killed at the limit", async () => {
  const { result } = startStep(
    ["sh", "-c", "sleep 60 & echo left"],
    1000,
    tmpdir()
  );
  const { code, output } = await result;
  expect(code).toBe(TIMED_OUT);
  expect(output).toContain("left");
  expect(output).toContain("sleep 60");
});
