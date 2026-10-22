import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CODEX } from "../src/platform";
import { execOk } from "../src/proc";

// The app's helper: Life compiled to one binary (`bun build --compile`), and the files it reads at run time (prompts,
// the agent's protocol, every page's assets, the pinned codex) beside it, at the paths the code reads them from, for the app to pass as `LIFE_ROOT`. Usage:
// `bun scripts/helper.ts [out]` (default dist/helper).

const ROOT = join(import.meta.dir, "..");
const out = process.argv[2] ?? join(ROOT, "dist", "helper");
const resources = join(out, "resources");

await rm(out, { force: true, recursive: true });
await mkdir(join(resources, "docs"), { recursive: true });
await execOk(
  [
    "bun",
    "build",
    "--compile",
    "--minify",
    join(ROOT, "src", "cli.ts"),
    "--outfile",
    join(out, "life"),
  ],
  { timeout: 300_000 }
);
await Promise.all([
  cp(join(ROOT, "prompts"), join(resources, "prompts"), { recursive: true }),
  cp(join(ROOT, "docs", "agent.md"), join(resources, "docs", "agent.md")),
  cp(join(ROOT, "assets"), join(resources, "assets"), { recursive: true }),
  cp(join(ROOT, CODEX), join(resources, CODEX)),
]);
console.log(`helper: ${join(out, "life")}, resources: ${resources}`);
