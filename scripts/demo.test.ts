import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("every fact and moment the README cites is in the demo scripts/demo.ts writes", () => {
  const out = join(mkdtempSync(join(tmpdir(), "life-demo-")), "demo");
  const run = Bun.spawnSync(["bun", join(import.meta.dir, "demo.ts"), out]);
  expect(run.exitCode).toBe(0);
  const memory = join(out, "data/memory");
  const written = ["observations", "moments"]
    .flatMap((dir) =>
      readdirSync(join(memory, dir)).map((f) =>
        readFileSync(join(memory, dir, f), "utf8")
      )
    )
    .join("");
  const readme = readFileSync(join(import.meta.dir, "../README.md"), "utf8");
  const cited = [...readme.matchAll(/\b(?:obs|mom)_[0-9a-f]{12}\b/g)].map(
    (m) => m[0]
  );
  expect(cited.length).toBeGreaterThan(0);
  expect(cited.filter((id) => !written.includes(`"id":"${id}"`))).toEqual([]);
});

test("the demo refuses a folder inside Life's own data", () => {
  const run = Bun.spawnSync([
    "bun",
    join(import.meta.dir, "demo.ts"),
    join(process.env.HOME ?? "", "Library/Application Support/Life/demo"),
  ]);
  expect(run.exitCode).toBe(1);
});
