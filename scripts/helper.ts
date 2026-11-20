import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CODEX } from "@life/server/src/core/platform";
import { execOk } from "@life/server/src/core/proc";

// The app's helper: Life compiled to one binary (`bun build --compile`), and the files it reads at run time (prompts,
// every page's assets, the pinned codex, the two ACP adapters) beside it, at the paths the code reads them from, for the app to pass as `LIFE_CODE_DIR`. Usage:
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
    join(ROOT, "apps", "server", "src", "desk", "life-entry.ts"),
    "--outfile",
    join(out, "life"),
  ],
  { timeout: 300_000 }
);
// The ACP adapters are Node scripts: each is bundled whole for bun, at the path `runtime-rows.ts` runs it from.
const ADAPTERS = ["claude-agent-acp", "codex-acp"];
await Promise.all([
  ...ADAPTERS.map((name) => {
    const at = join(
      "node_modules",
      "@agentclientprotocol",
      name,
      "dist",
      "index.js"
    );
    return execOk(
      [
        "bun",
        "build",
        "--target=bun",
        join(ROOT, at),
        "--outfile",
        join(resources, at),
      ],
      {
        timeout: 300_000,
      }
    );
  }),
  // The send guard's hook, bundled alone: an agent's every tool call waits for it (`runtime-rows.ts` runs it from here).
  execOk(
    [
      "bun",
      "build",
      "--target=bun",
      join(ROOT, "apps", "server", "src", "desk", "send-guard-hook.ts"),
      "--outfile",
      join(resources, "apps", "server", "src", "desk", "send-guard-hook.js"),
    ],
    { timeout: 300_000 }
  ),
  cp(join(ROOT, "prompts"), join(resources, "prompts"), { recursive: true }),
  cp(join(ROOT, "assets"), join(resources, "assets"), { recursive: true }),
  cp(join(ROOT, CODEX), join(resources, CODEX)),
]);
console.log(`helper: ${join(out, "life")}, resources: ${resources}`);
