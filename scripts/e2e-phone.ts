import { existsSync } from "node:fs";
import { join } from "node:path";

// The iPhone app's end-to-end flows (apps/lifelog/apps/ios/LifelogE2E): build once when Swift changed, keep three
// cloned simulators warm, run one flow per test class over them, print failures only.
// Usage: `bun run e2e:phone [TestClass …]`. Not in `bun run check` yet.

const IOS = join(import.meta.dir, "..", "apps/lifelog/apps/ios");
const DERIVED = "/tmp/lifelog-e2e-dd";
const SOURCE = "iPhone 18 Pro";
const CLONES = ["e2e-1"];
const WORKERS = 3;
const RESULT = join(DERIVED, "result.xcresult");
const STAMP = join(DERIVED, "built");

const run = (cmd: string[], cwd = IOS) => {
  const { stdout, stderr, exitCode } = Bun.spawnSync(cmd, { cwd });
  return { ok: exitCode === 0, out: stdout.toString() + stderr.toString() };
};
const t0 = performance.now();
const lap = (what: string) =>
  console.log(`${((performance.now() - t0) / 1000).toFixed(0)}s  ${what}`);

// Build when a Swift, project or fixture file is newer than the last build.
const stale = () =>
  !existsSync(STAMP) ||
  run([
    "find",
    ".",
    "../../fixtures/wire",
    "-newer",
    STAMP,
    "(",
    "-name",
    "*.swift",
    "-o",
    "-name",
    "project.yml",
    "-o",
    "-name",
    "*.json",
    ")",
    "-not",
    "-path",
    "*/.build/*",
    "-not",
    "-path",
    "*.xcodeproj/*",
  ]).out.trim() !== "";

if (stale()) {
  run(["xcodegen", "generate", "--quiet"]);
  const build = run([
    "xcodebuild",
    "-project",
    "Lifelog.xcodeproj",
    "-scheme",
    "Lifelog",
    "-configuration",
    "Debug",
    "-destination",
    `platform=iOS Simulator,name=${SOURCE}`,
    "-derivedDataPath",
    DERIVED,
    "build-for-testing",
  ]);
  if (!build.ok) {
    console.log(
      build.out
        .split("\n")
        .filter((l) => l.includes("error:"))
        .join("\n") || build.out.slice(-2000)
    );
    process.exit(1);
  }
  run(["touch", STAMP]);
  lap("built");
}

// The clones, made once from the stock simulator and kept (booted) between runs.
const devices = JSON.parse(
  run(["xcrun", "simctl", "list", "devices", "-j"]).out
).devices as Record<string, { name: string; udid: string; state: string }[]>;
const all = Object.values(devices).flat();
const udids = CLONES.map((name) => {
  const have = all.find((d) => d.name === name);
  if (have) {
    return have;
  }
  const source = all.find((d) => d.name === SOURCE);
  if (!source) {
    throw new Error(`no ${SOURCE} simulator`);
  }
  run(["xcrun", "simctl", "shutdown", source.udid]); // a clone needs its source shut down
  const made = run(["xcrun", "simctl", "clone", source.udid, name]).out.trim();
  return { name, state: "Shutdown", udid: made };
});
for (const d of udids) {
  if (d.state !== "Booted") {
    run(["xcrun", "simctl", "boot", d.udid]);
  }
  run([
    "xcrun",
    "simctl",
    "privacy",
    d.udid,
    "grant",
    "all",
    "com.ericedouard.lifelog",
  ]);
}
run(["xcrun", "simctl", "bootstatus", udids[0].udid]);
lap("simulators ready");

const only = process.argv
  .slice(2)
  .flatMap((c) => ["-only-testing", `LifelogE2E/${c}`]);
run(["rm", "-rf", RESULT]);
const test = run([
  "xcodebuild",
  "test-without-building",
  "-project",
  "Lifelog.xcodeproj",
  "-scheme",
  "LifelogE2E",
  "-derivedDataPath",
  DERIVED,
  "-destination",
  `platform=iOS Simulator,id=${udids[0].udid}`,
  "-resultBundlePath",
  RESULT,
  "-parallel-testing-enabled",
  "YES",
  "-parallel-testing-worker-count",
  String(WORKERS),
  "-collect-test-diagnostics",
  "never",
  "-test-timeouts-enabled",
  "YES",
  "-default-test-execution-time-allowance",
  "60",
  ...only,
]);
await Bun.write(join(DERIVED, "last.log"), test.out);
const lines = test.out.split("\n");
if (!test.ok) {
  const summary = JSON.parse(
    Bun.spawnSync([
      "xcrun",
      "xcresulttool",
      "get",
      "test-results",
      "summary",
      "--path",
      RESULT,
    ]).stdout.toString() || "{}"
  );
  for (const f of summary.testFailures ?? []) {
    console.log(`${f.testName}: ${f.failureText}`);
  }
}
console.log(
  lines.filter((l) => l.includes("Executed ")).at(-1) ?? test.out.slice(-1500)
);
lap(test.ok ? "passed" : "FAILED");
process.exit(test.ok ? 0 : 1);
