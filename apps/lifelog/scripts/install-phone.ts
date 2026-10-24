// Builds a commit in a temporary worktree, keeps its dSYMs, then installs it on the owner's iPhone
// and Watch and launches it:
//   bun run install:phone [-- <commit>] [--no-install] [--no-watch]
// The default commit is origin/main after a fetch. The dSYMs (app, widgets, Watch) go to the store
// in scripts/dsyms.ts before anything is installed, so every installed build can be symbolicated.
// --no-install only builds and archives. --no-watch skips the Watch. The Watch app embedded in the
// phone build can't be installed directly, so the Watch scheme is built and installed on its own.
// Devices: LIFELOG_PHONE_UDID and LIFELOG_WATCH_UDID, from the environment or the root checkout's .env
// (nothing of the owner's is committed).
import { $ } from "bun";
import { archive, checkouts } from "./dsyms";

const args = process.argv.slice(2);
const install = !args.includes("--no-install");
const watch = !args.includes("--no-watch");
const ref = args.find((a) => !a.startsWith("--")) ?? "origin/main";

const [root = "."] = await checkouts();
const dotenv = await Bun.file(`${root}/.env`)
  .text()
  .catch(() => "");
const device = (name: string) => {
  const udid =
    process.env[name] ?? dotenv.match(new RegExp(`^${name}=(\\S+)`, "m"))?.[1];
  if (!udid) {
    throw new Error(`set ${name} in ${root}/.env`);
  }
  return udid;
};
const phone = device("LIFELOG_PHONE_UDID");
const watchUdid = watch ? device("LIFELOG_WATCH_UDID") : "";
await $`git -C ${root} fetch --quiet origin`;
const sha = (
  await $`git -C ${root} rev-parse --short ${`${ref}^{commit}`}`.text()
).trim();
const tree = `${root}/.claude/worktrees/install-${sha}`;
const ios = `${tree}/apps/ios`;
const derived = `${tree}/.build/device`;
const products = `${derived}/Build/Products`;
const build = (scheme: string, udid: string, ...extra: string[]) =>
  $`xcodebuild -project Lifelog.xcodeproj -scheme ${scheme} -configuration Release -destination ${`id=${udid}`} -derivedDataPath ${derived} -allowProvisioningUpdates ${extra} -quiet build`.cwd(
    ios
  );

await $`git -C ${root} worktree add --detach --quiet ${tree} ${sha}`;
try {
  await $`xcodegen generate --quiet`.cwd(ios);
  await build("Lifelog", phone);
  if (watch) {
    await build(
      "LifelogWatch",
      watchUdid,
      "-allowProvisioningDeviceRegistration"
    );
  }
  const kept = await archive(products, "*/*.dSYM", sha);
  console.log(`dSYMs kept for ${sha}:`, kept.binaries);
  if (install) {
    await $`xcrun devicectl device install app --device ${phone} ${products}/Release-iphoneos/lifelog.app`;
    if (watch) {
      await $`xcrun devicectl device install app --device ${watchUdid} ${products}/Release-watchos/LifelogWatch.app`;
    }
    // The bundle id as built (LIFELOG_BUNDLE_ID in project.yml).
    const id = (
      await $`plutil -extract CFBundleIdentifier raw ${products}/Release-iphoneos/lifelog.app/Info.plist`.text()
    ).trim();
    await $`xcrun devicectl device process launch --device ${phone} ${id}`;
  }
} finally {
  await $`git -C ${root} worktree remove --force ${tree}`;
}
