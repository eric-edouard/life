// `bun run check`: the single quality gate. Runs every step concurrently and fails fast.
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import process from "node:process";
import { hold } from "@life/server/src/core/lock";
import { hasPassed, readCleanTree, recordPassed } from "./check-trees";

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
  "design types": ["bun", "x", "--bun", "tsc", "--noEmit", "-p", "apps/design"],
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
  // 8 workers: 34 s instead of 84 s one file at a time (21 Nov); more would only load the Mac further. 30 s a test:
  // bun's 5 s default timed out healthy tests whenever the Mac was loaded, failing whole pushes and trains (21 Nov).
  test: [
    "bun",
    "test",
    "--parallel=8",
    "--timeout",
    "30000",
    "./apps/server/src/",
    "./scripts/",
    "./apps/edge/",
    "./apps/design/",
  ],
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
  // The rows green on the Mac's last parity board still pass their flows (scripts/parity.ts).
  "parity gate": ["bun", "scripts/parity.ts", "--gate"],
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
// And every server file the phone's tests read by path (ContractTests' mirrored enums): a change there can break them.
const testReads = new Set(
  Array.from(new Bun.Glob(`${ios}/Kit/Tests/**/*.swift`).scanSync())
    .flatMap((f) => [
      ...readFileSync(f, "utf8").matchAll(
        /"([\w.-]+\/[\w./-]+\.(?:ts|json))"/g
      ),
    ])
    .map((m) => m[1])
);
const isSwiftRead = (f: string) =>
  SWIFT.test(f) || [...testReads].some((r) => f.endsWith(`/${r}`));
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
} else if (changed && !changed.some(isSwiftRead)) {
  why = "no change to the phone, the helper or what they read";
} else if (process.env.LIFE_CHECK_SWIFT === "at-landing") {
  // A branch's pushes before it lands (his yes of 21 Nov): the Swift builds run once, on the landing push.
  why = "runs on the landing push (LIFE_CHECK_SWIFT=at-landing)";
}
// A clean tree that passed (with the Swift builds, when they are due now) runs again only the steps that read his data
// outside the tree (`--unless-passed`, the pre-push hook). Read under the lock, so a second push waits for the first.
const LIVE = ["cases", "scrub", "voice eval"];
const tree = readCleanTree(".");
const swift = why === null;
const passed =
  tree !== null &&
  process.argv.includes("--unless-passed") &&
  hasPassed(".", tree, swift);
if (passed) {
  console.log(`- tree ${tree.slice(0, 12)} passed: only ${LIVE.join(", ")}`);
  for (const name of Object.keys(steps)) {
    if (!LIVE.includes(name)) {
      delete steps[name];
    }
  }
} else if (swift) {
  // The two swift tests, xcodebuild and the parity gate's simulators each take every core: one after another, so they
  // and the server tests are not all starved at once (load 188 with 0% idle at a landing, 21 Nov).
  const SERIAL = ["swift test", "swift test mac", "xcodebuild", "parity gate"];
  const quoted = (cmd: string[]) =>
    cmd.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ");
  for (const [name, cmd] of Object.entries(macSteps)) {
    if (!SERIAL.includes(name)) {
      steps[name] = cmd;
    }
  }
  steps["swift builds"] = [
    "sh",
    "-c",
    SERIAL.map((n) => `echo '== ${n}' && ${quoted(macSteps[n] ?? [])}`).join(
      " && "
    ),
  ];
} else {
  for (const name of Object.keys(macSteps)) {
    console.log(`- ${name}: skipped, ${why}`);
  }
}

// Only the current failures stay in derived/check.
await rm("derived/check", { force: true, recursive: true });

// Output is drained while the step runs, so a chatty step never blocks on a full pipe.
// Each step leads its own process group, so killing it reaches the processes it started
// (sh -> xcodebuild) and none is left holding a lock for the next run.
const started = performance.now();
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
    console.log(
      `✓ ${name} (${((performance.now() - started) / 1000).toFixed(1)} s)`
    );
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

// Recorded only when nothing changed while it ran.
if (!passed && tree && tree === readCleanTree(".")) {
  recordPassed(".", tree, swift);
}
