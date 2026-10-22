import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { execOk } from "../src/proc";

// A release a friend can open, published: Life.app signed with the owner's Developer ID under the hardened runtime,
// notarized and stapled; a zip of it (what Sparkle downloads, listed in appcast.xml with its EdDSA signature) and a DMG
// holding it, Lifelog Host beside it when its path is given (`LIFELOG_HOST_APP`); all three as a GitHub release of the
// repository the releases go to (`LIFE_RELEASES_REPO`, owner/name). Usage:
//   LIFE_SIGN_IDENTITY="Developer ID Application: …" LIFE_NOTARY_PROFILE=<notarytool profile> \
//   LIFE_RELEASES_REPO=<owner/name> LIFE_SPARKLE_KEY=<public EdDSA key> LIFE_VERSION=0.1.0 bun scripts/release.ts
// Set up once by the maintainer (docs/releasing.md): the Developer ID certificate, `xcrun notarytool
// store-credentials`, Sparkle's `generate_keys` (its private key stays in the Keychain), the repo.

const ROOT = join(import.meta.dir, "..");
const out = join(ROOT, "dist");
const identity = process.env.LIFE_SIGN_IDENTITY;
const profile = process.env.LIFE_NOTARY_PROFILE;
const version = process.env.LIFE_VERSION;
const repo = process.env.LIFE_RELEASES_REPO;
if (
  !(
    identity?.startsWith("Developer ID Application") &&
    profile &&
    version &&
    repo &&
    process.env.LIFE_SPARKLE_KEY
  )
) {
  throw new Error(
    "a release needs LIFE_SIGN_IDENTITY (a Developer ID Application identity), LIFE_NOTARY_PROFILE, LIFE_RELEASES_REPO, LIFE_SPARKLE_KEY and LIFE_VERSION"
  );
}
// The app's feed: the latest release's appcast.
process.env.LIFE_APPCAST_URL = `https://github.com/${repo}/releases/latest/download/appcast.xml`;

const run = (cmd: string[]) => execOk(cmd, { cwd: ROOT, timeout: 3_600_000 });

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

// The feed: Sparkle's generate_appcast signs the zip with the key in his Keychain and lists it, downloaded from this
// release.
const updates = join(out, "updates");
await rm(updates, { force: true, recursive: true });
await mkdir(updates, { recursive: true });
await run(["ditto", zip, join(updates, `Life-${version}.zip`)]);
await run([
  join(ROOT, "app", "Frameworks", "bin", "generate_appcast"),
  "--download-url-prefix",
  `https://github.com/${repo}/releases/download/v${version}/`,
  updates,
]);
await run([
  "gh",
  "release",
  "create",
  `v${version}`,
  "--repo",
  repo,
  "--title",
  `Life ${version}`,
  "--notes",
  `Life ${version}`,
  zip,
  dmg,
  join(updates, "appcast.xml"),
]);
console.log(
  `release ${version}: https://github.com/${repo}/releases/tag/v${version}`
);
