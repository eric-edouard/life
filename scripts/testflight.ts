import { join } from "node:path";
import { $ } from "bun";

// The iPhone app on TestFlight: archived, uploaded and added to the app's internal group with `asc`, one command:
//   bun scripts/testflight.ts [--notes "what to test"]
// It adds no one. A pilot becomes a tester when the owner makes them an App Store Connect user with the least role
// (docs/plans/2026-11-28-packaging/spec.md); an internal group holds those users, and a build added to it needs no
// beta review. The app's record must exist in App Store Connect (the bundle id in `project.yml`); `asc auth` is set up.

const ROOT = join(import.meta.dir, "..");
const IOS = join(ROOT, "apps", "lifelog", "apps", "ios");
const bundleId = (await Bun.file(join(IOS, "project.yml")).text()).match(
  /LIFELOG_BUNDLE_ID: (\S+)/
)?.[1];
const notesAt = process.argv.indexOf("--notes");
const notes = notesAt > 0 ? process.argv[notesAt + 1] : undefined;

const asc = async (...args: string[]) =>
  (await $`asc ${args} --output json`.quiet().json()) as {
    data: { id: string; attributes: { name: string } }[];
  };
const [app] = (await asc("apps", "list", "--bundle-id", `${bundleId}`)).data;
if (!app) {
  throw new Error(
    `no app ${bundleId} in App Store Connect: the owner creates its record once`
  );
}
const [group] = (
  await asc("testflight", "groups", "list", "--app", app.id, "--internal")
).data;
if (!group) {
  throw new Error(`${app.attributes.name} has no internal TestFlight group`);
}

// The build number is the UTC build time, as install-phone.ts makes it: it only grows.
const build = (await $`date -u +%Y%m%d.%H%M`.text()).trim();
await $`bun run ios:project`.cwd(ROOT);
await $`asc publish testflight ${[
  ...["--app", app.id, "--group", group.id, "--wait"],
  ...["--project", join(IOS, "Lifelog.xcodeproj"), "--scheme", "Lifelog"],
  ...["--archive-xcodebuild-flag", "-allowProvisioningUpdates"],
  ...["--archive-xcodebuild-flag", `CURRENT_PROJECT_VERSION=${build}`],
  ...["--build-number", build],
  ...(notes ? ["--test-notes", notes, "--locale", "en-US"] : []),
]}`;
console.log(
  `${app.attributes.name} ${build} is on TestFlight, group ${group.attributes.name}.`
);
