import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CODEX } from "@life/server/src/core/platform";
import { execOk } from "@life/server/src/core/proc";

// The app's helper: Life compiled to one binary (`bun build --compile`), and the files it reads at run time (prompts,
// every page's assets, the pinned codex, the two ACP adapters, pi and Life's pi extension) beside it, at the paths the code reads them from, for the app to pass as `LIFE_CODE_DIR`. Usage:
// `bun scripts/helper.ts [out]` (default dist/helper).

const ROOT = join(import.meta.dir, "..");
const out = process.argv[2] ?? join(ROOT, "dist", "helper");
const resources = join(out, "resources");
const PI = join("node_modules", "@earendil-works", "pi-coding-agent");

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
  // The send guard's hook and Life's pi extension, each bundled alone (`runtime-rows.ts` and pi's runtime run them from here).
  ...["desk/send-guard-hook", "desk/runtimes/pi-extension"].map((at) =>
    execOk(
      [
        "bun",
        "build",
        "--target=bun",
        join(ROOT, "apps", "server", "src", `${at}.ts`),
        "--outfile",
        join(resources, "apps", "server", "src", `${at}.js`),
      ],
      { timeout: 300_000 }
    )
  ),
  // pi ships bundled (its `dist/bundle`, which reads its `package.json`), run by the helper as bun; it loads Life's
  // extension with jiti, which it imports by name. Checked by running the pi runtime's tests from this layout.
  ...[
    join(PI, "package.json"),
    join(PI, "dist", "bundle"),
    join("node_modules", "jiti"),
  ].map((f) => cp(join(ROOT, f), join(resources, f), { recursive: true })),
  cp(join(ROOT, "prompts"), join(resources, "prompts"), { recursive: true }),
  cp(join(ROOT, "assets"), join(resources, "assets"), { recursive: true }),
  cp(join(ROOT, CODEX), join(resources, CODEX)),
]);
console.log(`helper: ${join(out, "life")}, resources: ${resources}`);
