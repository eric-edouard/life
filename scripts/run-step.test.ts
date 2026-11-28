import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { startStep, TIMED_OUT } from "./run-step";

const STUCK_WORKER = /(\d+) [\d.]+% CPU running .*spin\.test\.ts/;

test("a step past its limit is killed and the stuck test file is named, not the one before it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run-step-"));
  const spin = join(dir, "spin.test.ts");
  const first = join(dir, "first.test.ts");
  writeFileSync(
    first,
    'import { test } from "bun:test";\ntest("passes", () => {});\n'
  );
  writeFileSync(
    spin,
    'import { test } from "bun:test";\ntest("spins", () => { for (;;) {} });\n'
  );
  const { result } = startStep(
    [
      process.execPath,
      "test",
      "--isolate",
      "--preload",
      join(import.meta.dir, "note-test-file.ts"),
      first,
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
  expect(output).toContain(": sleep");
  expect(output).not.toContain("sleep 60");
});

test("a process in a group of its own dies with the step", async () => {
  const { result } = startStep(
    [
      process.execPath,
      "-e",
      'const c = Bun.spawn(["sleep", "60"], { detached: true }); console.log(c.pid); await c.exited;',
    ],
    5000,
    tmpdir()
  );
  const { output } = await result;
  await Bun.sleep(500);
  expect(() => process.kill(Number(output.split("\n")[0]), 0)).toThrow();
  expect(output).not.toContain("sleep 60");
}, 20_000);

test("without `ps` a step past its limit is still killed", async () => {
  const ps = spyOn(Bun, "spawnSync").mockImplementation(() => {
    throw new Error("EPERM");
  });
  const { result } = startStep(["sleep", "60"], 200, tmpdir());
  expect((await result).code).toBe(TIMED_OUT);
  ps.mockRestore();
});

test("a step that ended is not signalled again", async () => {
  const { kill, result } = startStep(["true"], 5000, tmpdir());
  await result;
  const signal = spyOn(process, "kill");
  expect(kill()).toEqual([]);
  expect(signal).not.toHaveBeenCalled();
  signal.mockRestore();
});
