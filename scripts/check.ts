// `bun run check`: the single quality gate. Runs every step concurrently and fails fast.
import { rm } from "node:fs/promises";
import process from "node:process";
import { hold } from "@life/server/src/core/lock";

// One check at a time on a machine: several worktrees' gates at once load it until time-limited tests fail.
await hold("check", process.cwd(), 5000);

const lifelog = "apps/lifelog";
const ios = `${lifelog}/apps/ios`;
const mac = `${lifelog}/apps/mac-quiet`;

// The gate builds Debug only, and install:phone builds Release, so a preview using a DEBUG-only
// helper (`.previewProcessing()`, `.preview()`) breaks the phone install. Every #Preview sits
// inside `#if DEBUG`. ponytail: previews only; a Release compile catches any DEBUG-only symbol
// but adds 4 to 17 s to the gate.
const debugOnlyPreviews = `
FNR == 1 { depth = 0 }
/^[ \\t]*#if/ { debug[++depth] = $0 ~ /#if[ \\t]+DEBUG([^A-Za-z0-9_]|$)/ }
/^[ \\t]*#else/ { debug[depth] = 0 }
/^[ \\t]*#endif/ { depth-- }
/^[ \\t]*#Preview/ {
  inside = 0
  for (i = 1; i <= depth; i++) if (debug[i]) inside = 1
  if (!inside) { print FILENAME ":" FNR ": #Preview outside #if DEBUG"; failed = 1 }
}
END { exit failed }`;

const steps: Record<string, string[]> = {
  biome: ["bun", "x", "--bun", "ultracite", "check"],
  cases: ["bun", "scripts/cases-check.ts"],
  fallow: ["bun", "x", "--bun", "fallow", "--fail-on-issues"],
  // The identity service's real test needs the models (its AGENTS.md); these need none.
  "identity test": [
    "python3",
    "-m",
    "unittest",
    "discover",
    "-s",
    `${lifelog}/apps/identity`,
    "-p",
    "test_contract.py",
  ],
  "lifelog test": [
    "bun",
    "test",
    "--timeout",
    "60000",
    `./${lifelog}/apps/server/`,
    `./${lifelog}/apps/stt-bench/`,
    `./${lifelog}/apps/voice-bench/`,
    `./${lifelog}/packages/`,
  ],
  openapi: ["bun", `${lifelog}/apps/server/scripts/openapi.ts`, "--check"],
  "py compile": [
    "python3",
    "-m",
    "py_compile",
    `${lifelog}/apps/identity/test_app.py`,
  ],
  // Vendored skills are upstream text.
  scrub: ["bun", "scripts/scrub-check.ts", ":!.claude/skills"],
  test: ["bun", "test", "./apps/server/src/", "./scripts/", "./apps/edge/"],
  types: ["bun", "x", "--bun", "tsc", "--noEmit"],
  // Replays his answered voices (on his Mac only) against the committed counts.
  "voice eval": [
    "bun",
    `${lifelog}/apps/server/scripts/eval-voices.ts`,
    "--check",
  ],
};

// The phone and the Mac helper (Lifelog Host) build on a Mac only, and only when a branch touches them or what they
// read; otherwise the gate says it skipped them. The Android app is parked: its own gradle build, outside the gate.
const macSteps: Record<string, string[]> = {
  "debug previews": [
    "awk",
    debugOnlyPreviews,
    ...new Bun.Glob(`${ios}/**/*.swift`).scanSync(),
  ],
  "swift format": [
    "swift",
    "format",
    "lint",
    "--strict",
    "--recursive",
    "--parallel",
    ios,
    mac,
  ],
  "swift test": [
    "swift",
    "test",
    "--package-path",
    `${ios}/Kit`,
    "--scratch-path",
    ".build/kit",
    "--quiet",
  ],
  "swift test mac": [
    "swift",
    "test",
    "--package-path",
    mac,
    "--scratch-path",
    ".build/mac-quiet",
    "--quiet",
  ],
  xcodebuild: [
    "sh",
    "-c",
    `cd '${ios}' && xcodegen generate --quiet && xcodebuild -project Lifelog.xcodeproj -scheme Lifelog -destination 'generic/platform=iOS Simulator' -derivedDataPath '${process.cwd()}/.build/DerivedData' -quiet build CODE_SIGNING_ALLOWED=NO`,
  ],
};
// The phone's and the helper's Swift, and what they read from the server (its wire fixtures and openapi.json).
const SWIFT =
  /^apps\/lifelog\/(apps\/ios|apps\/mac-quiet|fixtures|apps\/server\/openapi\.json)/;
// Without main to compare with (a clone with no origin), every step runs.
const base = await Bun.$`git merge-base origin/main HEAD`.nothrow().quiet();
const changed =
  base.exitCode === 0
    ? (
        await Bun.$`git diff --name-only ${base.text().trim()}; git ls-files --others --exclude-standard`.text()
      ).split("\n")
    : null;
let why: string | null = null;
if (process.platform !== "darwin") {
  why = "needs macOS";
} else if (changed && !changed.some((f) => SWIFT.test(f))) {
  why = "no change to the phone, the helper or what they read";
}
if (why) {
  for (const name of Object.keys(macSteps)) {
    console.log(`- ${name}: skipped, ${why}`);
  }
} else {
  Object.assign(steps, macSteps);
}

// Only the current failures stay in derived/check.
await rm("derived/check", { force: true, recursive: true });

// Output is drained while the step runs, so a chatty step never blocks on a full pipe.
// Each step leads its own process group, so killing it reaches the processes it started
// (sh -> xcodebuild) and none is left holding a lock for the next run.
const procs = Object.entries(steps).map(([name, cmd]) => {
  const proc = Bun.spawn(cmd, {
    detached: true,
    stderr: "pipe",
    stdout: "pipe",
  });
  const output = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then((parts) => parts.join(""));
  return { name, output, proc };
});

function killAll() {
  for (const { proc } of procs) {
    try {
      process.kill(-proc.pid);
    } catch {
      // The whole group has already exited.
    }
  }
}

const results = procs.map(async ({ name, output, proc }) => {
  const code = await proc.exited;
  if (code === 0) {
    console.log(`✓ ${name}`);
    return;
  }
  const out = await output;
  const log = `derived/check/${name}.log`;
  await Bun.write(log, out);
  console.error(
    `✗ ${name} (full log: ${log})\n${out.trim().split("\n").slice(-20).join("\n")}`
  );
  killAll();
  process.exit(1);
});

// Detached steps no longer get the terminal's Ctrl-C, so pass it on.
process.on("SIGINT", () => {
  killAll();
  process.exit(130);
});

await Promise.all(results);
