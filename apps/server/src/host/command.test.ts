import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryCommand } from "./command";

test("the memory verbs renamed in the names pass are gone under their old names", async () => {
  const quiet = console.error;
  console.error = () => undefined;
  try {
    const codes = await Promise.all(
      ["claim", "doubtful", "rate", "units", "unresolved"].map((old) =>
        memoryCommand([old])
      )
    );
    expect(codes).toEqual([2, 2, 2, 2, 2]);
  } finally {
    console.error = quiet;
  }
});

test("`bun life act` and `bun life grant` are gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-cli-"));
  const cli = join(import.meta.dir, "../desk/life-entry.ts");
  try {
    for (const old of ["act", "grant"]) {
      const run = Bun.spawnSync(["bun", cli, old], {
        env: { ...process.env, LIFE_OWNER_DATA_DIR: dir, LIFE_STATE_DIR: dir },
      });
      expect(run.exitCode).toBe(2);
      expect(run.stderr.toString()).toContain("change-todo-item");
      expect(run.stderr.toString()).toContain("auto-add");
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("an unknown flag is a usage mistake, never a crash in the run log", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-cli-"));
  try {
    const run = Bun.spawnSync(
      [
        "bun",
        join(import.meta.dir, "../desk/life-entry.ts"),
        "memory",
        "--help",
      ],
      {
        env: { ...process.env, LIFE_OWNER_DATA_DIR: dir, LIFE_STATE_DIR: dir },
      }
    );
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain("--help");
    expect(existsSync(join(dir, "log"))).toBe(false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
