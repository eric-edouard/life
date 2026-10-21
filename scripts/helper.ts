import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "../src/proc";

// The app's helper: Life compiled to one binary (`bun build --compile`), and the files it reads at run time (prompts,
// the agent's protocol, the connector's icons) beside it, for the app to pass as `LIFE_ROOT`. Usage:
// `bun scripts/helper.ts [out]` (default dist/helper).

const ROOT = join(import.meta.dir, "..");
const out = process.argv[2] ?? join(ROOT, "dist", "helper");
const resources = join(out, "resources");

await rm(out, { force: true, recursive: true });
await mkdir(join(resources, "docs"), { recursive: true });
const built = await exec(
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
if (built.code !== 0) {
  throw new Error(`bun build: ${built.stderr.trim()}`);
}
await Promise.all([
  cp(join(ROOT, "prompts"), join(resources, "prompts"), { recursive: true }),
  cp(join(ROOT, "docs", "agent.md"), join(resources, "docs", "agent.md")),
  cp(join(ROOT, "assets", "icon"), join(resources, "assets", "icon"), {
    recursive: true,
  }),
]);
console.log(`helper: ${join(out, "life")}, resources: ${resources}`);
