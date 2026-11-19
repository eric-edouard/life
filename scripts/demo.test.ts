import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** One demo for the tests that read it, removed after them. */
const folder = mkdtempSync(join(tmpdir(), "life-demo-"));
const out = join(folder, "demo");
afterAll(() => rmSync(folder, { force: true, recursive: true }));

test("every fact and episode the README and the examples cite is in the demo scripts/demo.ts writes", () => {
  const run = Bun.spawnSync(["bun", join(import.meta.dir, "demo.ts"), out]);
  expect(run.exitCode).toBe(0);
  const memory = join(out, "data/memory");
  const written = ["observations", "episodes"]
    .flatMap((dir) =>
      readdirSync(join(memory, dir)).map((f) =>
        readFileSync(join(memory, dir, f), "utf8")
      )
    )
    .join("");
  const readme = [
    "../README.md",
    "../docs/examples.md",
    "../assets/readme/diagrams.html",
  ]
    .map((f) => readFileSync(join(import.meta.dir, f), "utf8"))
    .join("");
  const cited = [...readme.matchAll(/\b(?:obs|ep)_[0-9a-f]{12}\b/g)].map(
    (m) => m[0]
  );
  expect(cited.length).toBeGreaterThan(0);
  expect(cited.filter((id) => !written.includes(`"id":"${id}"`))).toEqual([]);
});

test("the demo's inbox offers its new matter, the one `bun run e2e:demo` starts an agent on", () => {
  const checks = Bun.spawnSync(
    [
      "bun",
      join(import.meta.dir, "../apps/server/src/desk/life-entry.ts"),
      "memory",
      "checks",
    ],
    {
      env: {
        ...process.env,
        LIFE_MACHINE_DIR: join(out, "machine"),
        LIFE_OWNER_DATA_DIR: join(out, "data"),
        LIFE_STATE_DIR: join(out, "state"),
        NODE_ENV: "",
      },
    }
  );
  expect(checks.stdout.toString()).toContain("[new matter] matter_");
  expect(checks.stdout.toString()).toContain(
    "goal: Get the kitchen tap at the flat fixed\n"
  );
});

test("the demo refuses a folder inside his own data", () => {
  const run = Bun.spawnSync([
    "bun",
    join(import.meta.dir, "demo.ts"),
    join(homedir(), "Life", "demo"),
  ]);
  expect(run.exitCode).toBe(1);
});
