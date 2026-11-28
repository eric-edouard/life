import { mkdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOUR } from "@life/server/src/core/clock";
import { execOk } from "@life/server/src/core/proc";

// A release a friend can open, published: Life.app signed with the owner's Developer ID under the hardened runtime,
// notarized and stapled; a zip of it (what Sparkle downloads, listed in appcast.xml with its EdDSA signature) and a DMG
// holding it, Lifelog Host beside it when its path is given (`LIFELOG_HOST_APP`); all three as a GitHub release of the
// repository the releases go to (`LIFE_RELEASES_REPO`, owner/name). `LIFE_RELEASE_DRY=1` stops before anything is
// published: everything is built, signed and notarized, and the command it would run is shown. Usage:
//   LIFE_RELEASES_REPO=<owner/name> LIFE_SPARKLE_KEY=<public EdDSA key> LIFE_VERSION=0.1.0 bun scripts/release.ts
// Signing and notarizing use the maintainer's release keychain (`SIGNING_KEYCHAIN`: the Developer ID certificate and the
// notarytool profile, whose password is in 1Password, never here); `LIFE_SIGN_IDENTITY` and `LIFE_NOTARY_PROFILE` override
// the identity and the profile. Set up once (docs/releasing.md): the certificate, `xcrun notarytool store-credentials`,
// Sparkle's `generate_keys` (its private key stays in the Keychain), the repo.

const ROOT = join(import.meta.dir, "..");
const out = join(ROOT, "dist");
const dry = !!process.env.LIFE_RELEASE_DRY;
const SIGNING_KEYCHAIN = join(
  homedir(),
  "Library",
  "Keychains",
  "life-signing.keychain-db"
);
// The Developer ID certificate the release keychain holds (its name is the owner's, so it is read, never written here).
const identity =
  process.env.LIFE_SIGN_IDENTITY ??
  (
    await execOk([
      ...["security", "find-identity", "-v", "-p", "codesigning"],
      SIGNING_KEYCHAIN,
    ])
  ).match(/"(Developer ID Application: [^"]+)"/)?.[1] ??
  "";
const profile = process.env.LIFE_NOTARY_PROFILE ?? "life-notary";
const version = process.env.LIFE_VERSION;
const repo = process.env.LIFE_RELEASES_REPO;
if (
  !(
    identity.startsWith("Developer ID Application") &&
    version &&
    repo &&
    process.env.LIFE_SPARKLE_KEY
  )
) {
  throw new Error(
    "a release needs a Developer ID Application identity, LIFE_RELEASES_REPO, LIFE_SPARKLE_KEY and LIFE_VERSION"
  );
}
// What the build of the app is told (Bun's child processes do not see a changed `process.env`): the identity to sign
// with and the app's feed, the latest release's appcast.
const env = {
  ...process.env,
  LIFE_APPCAST_URL: `https://github.com/${repo}/releases/latest/download/appcast.xml`,
  LIFE_SIGN_IDENTITY: identity,
};

const run = (cmd: string[]) => execOk(cmd, { cwd: ROOT, env, timeout: HOUR });

/** Sends a file to Apple's notary service, waits for its answer, and staples the ticket to `staple`. */
async function notarize(file: string, staple: string) {
  await run([
    ...["xcrun", "notarytool", "submit", file, "--wait"],
    ...["--keychain-profile", profile, "--keychain", SIGNING_KEYCHAIN],
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
  join(ROOT, "apps", "mac", "Frameworks", "bin", "generate_appcast"),
  "--download-url-prefix",
  `https://github.com/${repo}/releases/download/v${version}/`,
  updates,
]);
const publish = [
  ...["gh", "release", "create", `v${version}`, "--repo", repo],
  ...["--title", `Life ${version}`, "--notes", `Life ${version}`],
  ...[zip, dmg, join(updates, "appcast.xml")],
];
if (dry) {
  console.log(
    `dry run, nothing published. Built: ${zip} ${dmg} ${updates}/appcast.xml\nPublishing would run: ${publish.join(" ")}`
  );
  process.exit(0);
}
await run(publish);
console.log(
  `release ${version}: https://github.com/${repo}/releases/tag/v${version}`
);
