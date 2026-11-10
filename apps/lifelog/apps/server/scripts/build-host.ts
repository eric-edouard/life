// The server as one file for the Mac host (packaging 4.6b): no Bun, no node_modules, no checkout. Its
// migrations, the VAD worker (a second entrypoint) and onnxruntime-web's WASM runtime are inside it;
// NOTICE, the licenses of what it bundles, goes beside it. `out` defaults to `.build/host`; `target`
// cross-compiles (`bun-windows-x64`).
//   bun run --cwd apps/server build:host [out]
import { copyFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");

export async function buildHost(out: string, target?: string) {
  // The runtime's files, from wherever the package is installed (the worker finds them by name).
  const ort = dirname(Bun.resolveSync("onnxruntime-web", root));
  const runtime = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]
    .map((name) => relative(root, join(ort, name)))
    .flatMap((path) => ["--asset", path]);
  const windows = target
    ? target.includes("windows")
    : process.platform === "win32";
  const binary = join(out, windows ? "lifelog-server.exe" : "lifelog-server");
  await $`bun build --compile ${target ? [`--target=${target}`] : []} ./src/index.ts ./src/vad-worker.ts ./src/voice-map-worker.ts --asset ../../packages/db/src/migrations ${runtime} --outfile ${binary}`
    .cwd(root)
    .quiet();
  await copyFile(join(root, "NOTICE"), join(out, "NOTICE"));
  return binary;
}

if (import.meta.main) {
  const out = resolve(process.argv[2] ?? join(root, "../../.build/host"));
  console.log(`built ${await buildHost(out)}`);
}
