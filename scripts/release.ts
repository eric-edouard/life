import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "../src/proc";

// A release a friend can open: Life.app signed with the owner's Developer ID under the hardened runtime, notarized and
// stapled; a zip of it (what an update downloads) and a DMG holding it, Lifelog Host beside it when its path is given
// (`LIFELOG_HOST_APP`), and a link to Applications. Usage:
//   LIFE_SIGN_IDENTITY="Developer ID Application: …" LIFE_NOTARY_PROFILE=<notarytool keychain profile> \
//   LIFE_VERSION=0.1.0 bun scripts/release.ts
// The notary profile is set once by the owner: `xcrun notarytool store-credentials` (docs/packaging.md, "Release").

const ROOT = join(import.meta.dir, "..");
const out = join(ROOT, "dist");
const identity = process.env.LIFE_SIGN_IDENTITY;
const profile = process.env.LIFE_NOTARY_PROFILE;
const version = process.env.LIFE_VERSION;
if (
  !(identity?.startsWith("Developer ID Application") && profile && version)
) {
  throw new Error(
    "a release needs LIFE_SIGN_IDENTITY (a Developer ID Application identity), LIFE_NOTARY_PROFILE and LIFE_VERSION"
  );
}

async function run(cmd: string[]) {
  const r = await exec(cmd, { cwd: ROOT, timeout: 3_600_000 });
  if (r.code !== 0) {
    throw new Error(
      `${cmd.slice(0, 2).join(" ")}: ${(r.stderr || r.stdout).trim().slice(-800)}`
    );
  }
  return r.stdout;
}

/** Sends a file to Apple's notary service, waits for its answer, and staples the ticket to `staple`. */
async function notarize(file: string, staple: string) {
  await run([
    "xcrun",
    "notarytool",
    "submit",
    file,
    "--keychain-profile",
    profile as string,
    "--wait",
  ]);
  await run(["xcrun", "stapler", "staple", staple]);
}

await run(["bun", join(ROOT, "scripts", "app.ts"), out]);
const app = join(out, "Life.app");
const zip = join(out, `Life-${version}.zip`);
await rm(zip, { force: true });
await run(["ditto", "-c", "-k", "--keepParent", app, zip]);
await notarize(zip, app);
// The zip again, now holding the stapled app: what an update downloads.
await rm(zip, { force: true });
await run(["ditto", "-c", "-k", "--keepParent", app, zip]);

const stage = join(out, "dmg");
await rm(stage, { force: true, recursive: true });
await mkdir(stage, { recursive: true });
await run(["ditto", app, join(stage, "Life.app")]);
const host = process.env.LIFELOG_HOST_APP;
if (host) {
  await run(["ditto", host, join(stage, "Lifelog Host.app")]);
}
await symlink("/Applications", join(stage, "Applications"));
const dmg = join(out, `Life-${version}.dmg`);
await rm(dmg, { force: true });
await run([
  "hdiutil",
  "create",
  "-volname",
  "Life",
  "-srcfolder",
  stage,
  "-format",
  "UDZO",
  dmg,
]);
await run(["codesign", "--sign", identity, "--timestamp", dmg]);
await notarize(dmg, dmg);
console.log(`release ${version}: ${dmg}, ${zip}`);
