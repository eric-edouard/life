// Preloaded by the check's `bun test` steps, once per test file: notes which file this process runs, so a step killed at
// its time limit names the stuck one (`run-step.ts`).
import { mkdirSync, writeFileSync } from "node:fs";
import process from "node:process";

const dir = process.env.LIFE_CHECK_TEST_FILES;
if (dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${process.pid}`, Bun.main);
}
