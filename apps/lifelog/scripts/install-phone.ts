// Builds a commit in one standing worktree (its derived data stays, so a build recompiles only what changed), keeps its dSYMs, then installs it on the owner's iPhone
// and Watch and launches it:
//   bun run install:phone [-- <commit>] [--no-install] [--no-watch]
// The default commit is origin/main after a fetch. The dSYMs (app, widgets, Watch) go to the store
// in scripts/dsyms.ts before anything is installed, so every installed build can be symbolicated.
// --no-install only builds and archives. --no-watch skips the Watch. The Watch app embedded in the
// phone build can't be installed directly, so the Watch scheme is built and installed on its own.
// A build is skipped when the iOS app's files, the devices and Xcode are the ones of the last build that finished (its key,
// beside the products); the install and launch still run. Each step prints its time.
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
const tree = `${root}/.claude/worktrees/install-build`;
// lifelog's folder in the worktree of Life's repo.
const lifelog = `${tree}/apps/lifelog`;
const ios = `${lifelog}/apps/ios`;
const derived = `${lifelog}/.build/device`;
const products = `${derived}/Build/Products`;
// The build number, the UTC build time: computed once, so the phone's and the watch's builds carry the same one.
const stamp = (await $`date -u +%Y%m%d.%H%M`.text()).trim();
const build = (scheme: string, udid: string, ...extra: string[]) =>
  $`xcodebuild -project Lifelog.xcodeproj -scheme ${scheme} -configuration Release -destination ${`id=${udid}`} -derivedDataPath ${derived} -allowProvisioningUpdates ${extra} ${`CURRENT_PROJECT_VERSION=${stamp}`} -quiet build`.cwd(
    ios
  );
const step = async <T>(name: string, run: () => Promise<T>) => {
  const start = performance.now();
  const out = await run();
  console.log(`${name}: ${((performance.now() - start) / 1000).toFixed(1)} s`);
  return out;
};

await $`git -C ${root} worktree prune`;
await step("checkout", async () => {
  if (await Bun.file(`${tree}/.git`).exists()) {
    await $`git -C ${tree} checkout --quiet --force --detach ${sha}`;
  } else {
    await $`git -C ${root} worktree add --detach --quiet ${tree} ${sha}`;
  }
});
// What the build reads: the iOS app's tree, the devices it is signed for and Xcode; written after a build finished.
const key = [
  (
    await $`git -C ${tree} rev-parse ${"HEAD:apps/lifelog/apps/ios"}`.text()
  ).trim(),
  phone,
  watchUdid,
  (await $`xcodebuild -version`.text()).trim(),
].join("|");
const keyFile = `${derived}/built.key`;
const isBuilt =
  (await Bun.file(keyFile)
    .text()
    .catch(() => "")) === key &&
  (await Bun.file(
    `${products}/Release-iphoneos/lifelog.app/Info.plist`
  ).exists());
if (isBuilt) {
  console.log(
    "build: skipped, the iOS app has not changed since the last build"
  );
} else {
  await $`rm -f ${keyFile}`;
  await step("xcodegen", () => $`xcodegen generate --quiet`.cwd(ios));
  await step("build phone", () => build("Lifelog", phone));
  if (watch) {
    await step("build watch", () =>
      build("LifelogWatch", watchUdid, "-allowProvisioningDeviceRegistration")
    );
  }
  const kept = await archive(products, "*/*.dSYM", sha);
  console.log(`dSYMs kept for ${sha}:`, kept.binaries);
  await Bun.write(keyFile, key);
}
if (install) {
  await step("install", async () => {
    await $`xcrun devicectl device install app --device ${phone} ${products}/Release-iphoneos/lifelog.app`;
    if (watch) {
      await $`xcrun devicectl device install app --device ${watchUdid} ${products}/Release-watchos/LifelogWatch.app`;
    }
  });
  // The bundle id as built (LIFELOG_BUNDLE_ID in project.yml).
  const id = (
    await $`plutil -extract CFBundleIdentifier raw ${products}/Release-iphoneos/lifelog.app/Info.plist`.text()
  ).trim();
  await step(
    "launch",
    () => $`xcrun devicectl device process launch --device ${phone} ${id}`
  );
}
