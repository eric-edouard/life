import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec, execOk } from "@life/server/src/core/proc";

// The iOS simulator for the scripts that drive the phone app (`e2e-demo.ts`, `design-shots.ts`): build the Debug app,
// find or create a simulator, boot it, install, launch, photograph a display, shut down.

const REPO = join(import.meta.dir, "..");
export const APP_ID = "com.ericedouard.lifelog";

interface Device {
  isAvailable: boolean;
  name: string;
  state: string;
  udid: string;
}

/** The simulator named `name`, if one exists. */
export async function findSimulator(name: string) {
  const { devices } = JSON.parse(
    await execOk(["xcrun", "simctl", "list", "devices", "-j"])
  ) as { devices: Record<string, Device[]> };
  return Object.values(devices)
    .flat()
    .find((d) => d.name === name && d.isAvailable);
}

/**
 * A new simulator named `name` on the newest iOS runtime, of `deviceType` (else its first iPhone): an older runtime may
 * be a beta that lacks the SDK's APIs, and the app dies.
 */
export async function createSimulator(name: string, deviceType?: string) {
  const { runtimes } = JSON.parse(
    await execOk(["xcrun", "simctl", "list", "runtimes", "-j"])
  ) as {
    runtimes: {
      identifier: string;
      platform: string;
      supportedDeviceTypes: { identifier: string; productFamily: string }[];
    }[];
  };
  const newest = runtimes.filter((r) => r.platform === "iOS").at(-1);
  const type = newest?.supportedDeviceTypes.find((d) =>
    deviceType ? d.identifier === deviceType : d.productFamily === "iPhone"
  );
  if (!(newest && type)) {
    throw new Error(`no iOS runtime with ${deviceType ?? "an iPhone"}`);
  }
  return (
    await execOk([
      "xcrun",
      "simctl",
      "create",
      name,
      type.identifier,
      newest.identifier,
    ])
  ).trim();
}

/** What the app is built from: the iOS tree at HEAD, its uncommitted changes and its untracked files' names. */
export async function sourceStamp() {
  const dir = "apps/lifelog/apps/ios";
  const git = (args: string[]) => execOk(["git", ...args], { cwd: REPO });
  const parts = [
    await git(["rev-parse", `HEAD:${dir}`]),
    await git(["diff", "HEAD", "--", dir]),
    await git(["ls-files", "-o", "--exclude-standard", "--", dir]),
  ];
  return new Bun.CryptoHasher("sha256").update(parts.join("\0")).digest("hex");
}

/**
 * Builds the Debug app for `udid` into `derivedData`; returns the app's path. A build of the same sources (`sourceStamp`,
 * kept beside it) is reused.
 */
export async function buildApp(udid: string, derivedData: string) {
  const app = join(
    derivedData,
    "Build/Products/Debug-iphonesimulator/lifelog.app"
  );
  const stampFile = join(derivedData, ".source-stamp");
  const stamp = await sourceStamp();
  if (
    existsSync(app) &&
    existsSync(stampFile) &&
    readFileSync(stampFile, "utf8") === stamp
  ) {
    return app;
  }
  await execOk(["bun", "run", "ios:project"], { cwd: REPO });
  await execOk(
    [
      "xcodebuild",
      ...["-project", "apps/lifelog/apps/ios/Lifelog.xcodeproj"],
      ...["-scheme", "Lifelog", "-configuration", "Debug"],
      ...["-destination", `id=${udid}`, "-derivedDataPath", derivedData],
      "build",
      "-quiet",
    ],
    { cwd: REPO, timeout: 30 * 60_000 }
  );
  writeFileSync(stampFile, stamp);
  return app;
}

/** Boots `udid`; `-b` does nothing when it runs already, and waits out one still shutting down. */
export const boot = (udid: string) =>
  execOk(["xcrun", "simctl", "bootstatus", udid, "-b"], { timeout: 300_000 });

export const install = (udid: string, app: string) =>
  execOk(["xcrun", "simctl", "install", udid, app]);

/** Starts the app afresh with `args`. */
export const launch = (udid: string, args: string[]) =>
  execOk([
    ...["xcrun", "simctl", "launch", "--terminate-running-process"],
    ...[udid, APP_ID, ...args],
  ]);

/**
 * A screenshot of one display, named by simctl (`primary`; the iPhone Duo closed shows on it): agent-device's screenshot
 * fails on a phone with two.
 */
export const screenshot = (udid: string, display: string, path: string) =>
  execOk([
    "xcrun",
    "simctl",
    "io",
    udid,
    "screenshot",
    `--display=${display}`,
    path,
  ]);

export const shutdown = (udid: string) =>
  exec(["xcrun", "simctl", "shutdown", udid]);

export const remove = (udid: string) =>
  exec(["xcrun", "simctl", "delete", udid]);
