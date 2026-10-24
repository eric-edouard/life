// The single quality gate. Runs every check concurrently and fails fast.

const ios = "apps/ios";
const mac = "apps/mac-quiet";

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

// Drizzle runs a migration only if its journal `when` is after the last one applied: two branches once both took
// index 38, and production would have skipped one silently. Every file is in the journal, `when` strictly rising.
const drizzle = "packages/db/src/migrations";
const journal: { entries: { tag: string; when: number }[] } = await Bun.file(
  `${drizzle}/meta/_journal.json`
).json();
const tags = new Set(journal.entries.map((e) => e.tag));
const problems = [
  ...[...new Bun.Glob("*.sql").scanSync(drizzle)]
    .filter((file) => !tags.has(file.slice(0, -".sql".length)))
    .map((file) => `${file} is not in the journal`),
  ...journal.entries
    .filter((e, i) => i > 0 && e.when <= (journal.entries[i - 1]?.when ?? 0))
    .map((e) => `${e.tag}: its when is not after the one before`),
];
if (problems.length > 0) {
  console.error(`✗ drizzle journal\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("✓ drizzle journal");

const steps: Record<string, string[]> = {
  // The Android app's unit tests and a debug APK; skipped on a Mac without the Android SDK (apps/android/AGENTS.md).
  android: [
    "sh",
    "-c",
    `sdk="\${ANDROID_HOME:-$HOME/Library/Android/sdk}"; [ -d "$sdk" ] || { echo "android: skipped, no Android SDK"; exit; }; cd apps/android && ANDROID_HOME="$sdk" JAVA_HOME="$(/usr/libexec/java_home -v 17+)" ./gradlew -q testDebugUnitTest assembleDebug`,
  ],
  biome: ["bunx", "biome", "check", "."],
  "bun test": ["bunx", "turbo", "run", "test", "--output-logs=errors-only"],
  "check-types": [
    "bunx",
    "turbo",
    "run",
    "check-types",
    "--output-logs=errors-only",
  ],
  "debug previews": [
    "awk",
    debugOnlyPreviews,
    ...new Bun.Glob(`${ios}/**/*.swift`).scanSync(),
  ],
  fallow: ["bunx", "fallow", "--fail-on-issues"],
  "identity test": [
    "python3",
    "-m",
    "unittest",
    "discover",
    "-s",
    "apps/identity",
    "-p",
    "test_contract.py",
  ],
  openapi: ["bun", "apps/server/scripts/openapi.ts", "--check"],
  // The identity service's real test needs the models (apps/identity/AGENTS.md); this one needs none.
  "py compile": ["python3", "-m", "py_compile", "apps/identity/test_app.py"],
  // Nothing of the owner's is committed: the script LIFELOG_SCRUB names (the owner's is Life's scripts/scrub-check.ts,
  // against his truth), given git pathspecs. Vendored skills are upstream text.
  scrub: [
    "sh",
    "-c",
    `[ -f "$LIFELOG_SCRUB" ] || { echo "scrub: skipped, LIFELOG_SCRUB names no file"; exit; }; exec bun "$LIFELOG_SCRUB" ':!.claude/skills'`,
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
    `cd ${ios} && xcodegen generate --quiet && xcodebuild -project Lifelog.xcodeproj -scheme Lifelog -destination 'generic/platform=iOS Simulator' -derivedDataPath ../../.build/DerivedData -quiet build CODE_SIGNING_ALLOWED=NO`,
  ],
};

// Output is drained while the step runs, so a chatty step never blocks on a full pipe.
// Each step leads its own process group, so killing it reaches the processes it started
// (sh -> xcodebuild, turbo -> bun test) and none is left holding a lock for the next run.
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

const results = procs.map(async ({ name, output, proc }) => {
  const code = await proc.exited;
  if (code === 0) {
    console.log(`✓ ${name}`);
    return;
  }
  const out = await output;
  const log = `.build/check/${name.replaceAll(" ", "-")}.log`;
  await Bun.write(log, out);
  console.error(
    `✗ ${name} (full log: ${log})\n${out.trim().split("\n").slice(-20).join("\n")}`
  );
  killAll();
  process.exit(1);
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

// Detached steps no longer get the terminal's Ctrl-C, so pass it on.
process.on("SIGINT", () => {
  killAll();
  process.exit(130);
});

await Promise.all(results);
