import { cp, mkdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { BUILT, PAGE } from "../src/dashboard";
import { CODEX } from "../src/llm";
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
// The status page, bundled once here: the app carries no React to bundle it with at run time (src/dashboard.ts).
const page = await Bun.build({
  ...PAGE,
  outdir: join(resources, relative(ROOT, BUILT)),
});
if (!page.success) {
  throw new Error(`status page: ${page.logs.map(String).join("\n")}`);
}
console.log(`helper: ${join(out, "life")}, resources: ${resources}`);
