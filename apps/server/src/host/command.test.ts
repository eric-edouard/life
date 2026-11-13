import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
  const cli = join(import.meta.dir, "cli.ts");
  for (const old of ["act", "grant"]) {
    const run = Bun.spawnSync(["bun", cli, old], {
      env: { ...process.env, LIFE_OWNER_DATA_DIR: dir, LIFE_STATE_DIR: dir },
    });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain("change-todo-item");
    expect(run.stderr.toString()).toContain("auto-add");
  }
});
